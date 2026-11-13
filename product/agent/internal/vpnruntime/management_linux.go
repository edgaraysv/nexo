//go:build linux

package vpnruntime

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	managementSocketMode = os.FileMode(0600)

	// Both budgets are measured from the single monotonic T0 captured at the
	// entry of the local revocation flow. They bound local observation only;
	// they do not change or accelerate OpenVPN's own scheduled exit timer.
	managementAcceptBudget = 2 * time.Second
	managementTotalBudget  = 10 * time.Second

	managementDialTimeout = 3 * time.Second
)

// managementStatusPollInterval is kept as a variable so unit tests can shorten
// it. Production never changes it at runtime.
var managementStatusPollInterval = 100 * time.Millisecond

type managementBudget struct {
	accept time.Duration
	total  time.Duration
	poll   time.Duration
}

var defaultManagementBudget = managementBudget{
	accept: managementAcceptBudget,
	total:  managementTotalBudget,
	poll:   managementStatusPollInterval,
}

var (
	managementClientIDPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	managementPeerIDPattern   = regexp.MustCompile(`^[0-9]+$`)
)

var (
	errManagementTimeout      = errors.New("management response timeout")
	errManagementEOF          = errors.New("management connection closed")
	errManagementIncomplete   = errors.New("management response incomplete")
	errManagementProtocol     = errors.New("unexpected management frame")
	errPeerNotFound           = errors.New("management peer with exact common name not found")
	errPeerAmbiguous          = errors.New("multiple management peers match common name")
	errPeerIdentityChanged    = errors.New("management peer identity changed")
	errControlPeerLost        = errors.New("management control peer lost")
	errControlPeerUnavailable = errors.New("management control peer unavailable")
)

// managementClock supplies the single monotonic time source used for T0,
// deadlines and elapsed measurements. Production uses time.Now, which carries
// the monotonic reading; tests can inject a fake clock.
type managementClock interface {
	Now() time.Time
}

type systemManagementClock struct{}

func (systemManagementClock) Now() time.Time { return time.Now() }

func normalizeManagementClientID(clientID string) (string, error) {
	if !managementClientIDPattern.MatchString(clientID) {
		return "", errors.New("invalid management client id")
	}
	// OpenVPN 2.6.14 source: manage.c:1010-1015 parses client-kill with
	// sscanf("%lu", &cid); manage.h:65 declares unsigned long cid. On the
	// supported Linux amd64/arm64 builds unsigned long is 64-bit. Parse
	// unsigned without sign or overflow; reject values above MaxUint64.
	value, err := strconv.ParseUint(clientID, 10, 64)
	if err != nil {
		return "", errors.New("invalid management client id")
	}
	return strconv.FormatUint(value, 10), nil
}

// managementClientKillCommand builds the only disconnect command allowed by
// the contract. client-kill takes a numeric Client ID obtained from status 3;
// the device common name is never interpolated into a management command.
func managementClientKillCommand(clientID string) (string, error) {
	normalized, err := normalizeManagementClientID(clientID)
	if err != nil {
		return "", err
	}
	return "client-kill " + normalized + "\n", nil
}

// managementExpectedCommonName validates the device UUID and returns the
// exact CN issued by issueClientCertificate.
func managementExpectedCommonName(deviceID string) (string, error) {
	if !credentialID.MatchString(deviceID) {
		return "", errors.New("invalid management common name")
	}
	return "nexo:" + deviceID, nil
}

// requireRootClient enforces the agent side of the management contract: only
// the privileged node-agent process may connect to the socket.
func requireRootClient(uid int) error {
	if uid != 0 {
		return errors.New("management client must run as root")
	}
	return nil
}

// prepareManagementSocket implements the ordered hand-off from OpenVPN to the
// agent: the path must already be a socket owned by expectedUID:expectedGID,
// then it is tightened to 0600 and re-verified. Any failure is fail-closed and
// the caller must not connect.
func prepareManagementSocket(path string, expectedUID, expectedGID uint32) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return errors.New("management endpoint is not a unix socket")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("management socket owner unavailable")
	}
	if stat.Uid != expectedUID || stat.Gid != expectedGID {
		return errors.New("management socket owner mismatch")
	}
	if err = os.Chmod(path, managementSocketMode); err != nil {
		return err
	}
	info, err = os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != managementSocketMode {
		return errors.New("management socket mode verification failed")
	}
	stat, ok = info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != expectedUID || stat.Gid != expectedGID {
		return errors.New("management socket owner verification failed")
	}
	return nil
}

type managementPeer struct {
	CommonName  string
	RealAddress string
	VirtualAddr string
	ClientID    string
	PeerID      string
	ConnectedAt string
}

type statusColumns struct {
	commonName  int
	realAddress int
	virtualAddr int
	clientID    int
	peerID      int
	connectedAt int
}

type managementTerminal int

const (
	managementTerminalNone managementTerminal = iota
	managementTerminalSuccess
	managementTerminalError
)

// readManagementLine reads one complete line. A partial line at EOF is
// reported as incomplete, never as a valid frame.
func readManagementLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		if errors.Is(err, io.EOF) {
			if line != "" {
				return "", fmt.Errorf("%w: partial line", errManagementIncomplete)
			}
			return "", errManagementEOF
		}
		var networkErr net.Error
		if errors.As(err, &networkErr) && networkErr.Timeout() {
			return "", fmt.Errorf("%w: %v", errManagementTimeout, err)
		}
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// parseStatusResponse consumes a complete status 3 response up to END. Async
// management events (>LOG:, >CLIENT:, ...) may be interleaved and are ignored.
// A unique CLIENT_LIST header, exact END and exact field values are required so
// protocol drift cannot look like an empty or matching peer list.
func parseStatusResponse(reader *bufio.Reader) ([]managementPeer, error) {
	var (
		columns         *statusColumns
		sawClientHeader bool
		peers           = make([]managementPeer, 0)
	)
	for {
		line, err := readManagementLine(reader)
		if err != nil {
			return nil, err
		}
		if line == "" || strings.HasPrefix(line, ">") {
			continue
		}
		fields := strings.Split(line, "\t")
		switch fields[0] {
		case "HEADER":
			if len(fields) >= 2 && fields[1] == "CLIENT_LIST" {
				if sawClientHeader {
					return nil, fmt.Errorf("%w: duplicate CLIENT_LIST header", errManagementProtocol)
				}
				parsed, err := parseStatusHeader(fields[2:])
				if err != nil {
					return nil, err
				}
				columns = &parsed
				sawClientHeader = true
			}
		case "CLIENT_LIST":
			if !sawClientHeader || columns == nil {
				return nil, fmt.Errorf("%w: CLIENT_LIST before CLIENT_LIST header", errManagementProtocol)
			}
			peer, err := parseStatusPeer(*columns, fields)
			if err != nil {
				return nil, err
			}
			peers = append(peers, peer)
		case "TITLE", "TIME", "ROUTING_TABLE", "GLOBAL_STATS":
			// Non-peer frames are allowed but do not contribute identity.
		case "END":
			if len(fields) != 1 {
				return nil, fmt.Errorf("%w: malformed END frame", errManagementProtocol)
			}
			if !sawClientHeader {
				return nil, fmt.Errorf("%w: END before CLIENT_LIST header", errManagementProtocol)
			}
			return peers, nil
		default:
			return nil, fmt.Errorf("%w: %q", errManagementProtocol, line)
		}
	}
}

func parseStatusHeader(names []string) (statusColumns, error) {
	columns := statusColumns{
		commonName:  -1,
		realAddress: -1,
		virtualAddr: -1,
		clientID:    -1,
		peerID:      -1,
		connectedAt: -1,
	}
	seen := make(map[string]bool, len(names))
	for index, name := range names {
		if seen[name] {
			return statusColumns{}, fmt.Errorf("%w: duplicate CLIENT_LIST column %q", errManagementProtocol, name)
		}
		seen[name] = true
		// Header names are relative to fields[2:] while CLIENT_LIST rows
		// carry the row type in fields[0]. Shift by one so the same column
		// indices address both frames.
		column := index + 1
		switch name {
		case "Common Name":
			columns.commonName = column
		case "Real Address":
			columns.realAddress = column
		case "Virtual Address":
			columns.virtualAddr = column
		case "Client ID":
			columns.clientID = column
		case "Peer ID":
			columns.peerID = column
		case "Connected Since":
			columns.connectedAt = column
		}
	}
	if columns.commonName < 0 || columns.realAddress < 0 || columns.clientID < 0 || columns.peerID < 0 {
		return statusColumns{}, fmt.Errorf("%w: CLIENT_LIST header lacks identity columns", errManagementIncomplete)
	}
	return columns, nil
}

func parseStatusPeer(columns statusColumns, fields []string) (managementPeer, error) {
	maximum := columns.commonName
	for _, index := range []int{columns.realAddress, columns.clientID, columns.peerID} {
		if index > maximum {
			maximum = index
		}
	}
	if len(fields) <= maximum {
		return managementPeer{}, fmt.Errorf("%w: short CLIENT_LIST row", errManagementIncomplete)
	}
	// Do not trim identity fields: a padded CN or endpoint is a different,
	// invalid identity, not the contracted value.
	peer := managementPeer{
		CommonName:  fields[columns.commonName],
		RealAddress: fields[columns.realAddress],
		ClientID:    fields[columns.clientID],
		PeerID:      fields[columns.peerID],
	}
	if columns.virtualAddr >= 0 && len(fields) > columns.virtualAddr {
		peer.VirtualAddr = fields[columns.virtualAddr]
	}
	if columns.connectedAt >= 0 && len(fields) > columns.connectedAt {
		peer.ConnectedAt = fields[columns.connectedAt]
	}
	if peer.CommonName == "" || peer.RealAddress == "" {
		return managementPeer{}, fmt.Errorf("%w: CLIENT_LIST row lacks identity", errManagementIncomplete)
	}
	normalizedClientID, err := normalizeManagementClientID(peer.ClientID)
	if err != nil {
		return managementPeer{}, fmt.Errorf("%w: invalid Client ID", errManagementIncomplete)
	}
	peer.ClientID = normalizedClientID
	if !managementPeerIDPattern.MatchString(peer.PeerID) {
		return managementPeer{}, fmt.Errorf("%w: invalid Peer ID", errManagementIncomplete)
	}
	return peer, nil
}

// readManagementTerminal reads until a complete terminal line. Interleaved
// >LOG:/>CLIENT: events are ignored. Only a complete SUCCESS: line is
// acceptance; ERROR: is rejection. EOF, timeout and partial lines are not
// acceptance.
func readManagementTerminal(reader *bufio.Reader) (managementTerminal, string, error) {
	for {
		line, err := readManagementLine(reader)
		if err != nil {
			return managementTerminalNone, "", err
		}
		if line == "" || strings.HasPrefix(line, ">") {
			continue
		}
		switch {
		case strings.HasPrefix(line, "SUCCESS:"):
			return managementTerminalSuccess, line, nil
		case strings.HasPrefix(line, "ERROR:"):
			return managementTerminalError, line, nil
		default:
			return managementTerminalNone, "", fmt.Errorf("%w: %q", errManagementProtocol, line)
		}
	}
}

func selectTargetPeer(peers []managementPeer, commonName string) (managementPeer, error) {
	var matches []managementPeer
	for _, peer := range peers {
		if peer.CommonName == commonName {
			matches = append(matches, peer)
		}
	}
	if len(matches) == 0 {
		return managementPeer{}, errPeerNotFound
	}
	if len(matches) > 1 {
		return managementPeer{}, errPeerAmbiguous
	}
	return matches[0], nil
}

func samePeerIdentity(first, second managementPeer) bool {
	return first.CommonName == second.CommonName &&
		first.ClientID == second.ClientID &&
		first.PeerID == second.PeerID &&
		first.RealAddress == second.RealAddress
}

func controlPeers(peers []managementPeer, target managementPeer) []managementPeer {
	controls := make([]managementPeer, 0, len(peers))
	for _, peer := range peers {
		if samePeerIdentity(peer, target) {
			continue
		}
		controls = append(controls, peer)
	}
	return controls
}

// controlPeerPresent confirms that at least one peer observed before the
// command is still listed. Controls are matched by device common name: a
// control that reconnects during the observation window is still the same
// non-target device, while the target itself is matched by full identity.
func controlPeerPresent(peers []managementPeer, controls []managementPeer) bool {
	for _, control := range controls {
		for _, peer := range peers {
			if peer.CommonName == control.CommonName {
				return true
			}
		}
	}
	return false
}

func countTargetPeers(peers []managementPeer, commonName string) int {
	count := 0
	for _, peer := range peers {
		if peer.CommonName == commonName {
			count++
		}
	}
	return count
}

func elapsedNS(start, end time.Time) int64 {
	if end.Before(start) {
		return 0
	}
	return end.Sub(start).Nanoseconds()
}

type managementStatusRead struct {
	Peers []managementPeer
	Start time.Time
	End   time.Time
}

type managementCommandResult struct {
	Command      string
	Sent         bool
	BytesWritten int
	Partial      bool
	WriteStart   time.Time
	WriteEnd     time.Time
	TerminalAt   time.Time
	Terminal     managementTerminal
	TerminalLine string
}

type managementConnectTiming struct {
	Start       time.Time
	DialStart   time.Time
	DialEnd     time.Time
	GreetingEnd time.Time
}

type managementSession struct {
	connection net.Conn
	reader     *bufio.Reader
	clock      managementClock
	connect    managementConnectTiming
}

func (session *managementSession) Close() error {
	return session.connection.Close()
}

func openManagementSession(socketPath string, expectedUID, expectedGID uint32, deadline time.Time, clock managementClock) (*managementSession, error) {
	session := &managementSession{clock: clock}
	session.connect.Start = clock.Now()
	if err := prepareManagementSocket(socketPath, expectedUID, expectedGID); err != nil {
		return nil, err
	}
	if !clock.Now().Before(deadline) {
		return nil, fmt.Errorf("%w: connect deadline", errManagementTimeout)
	}
	session.connect.DialStart = clock.Now()
	dialTimeout := time.Until(deadline)
	if dialTimeout <= 0 {
		return nil, fmt.Errorf("%w: connect deadline", errManagementTimeout)
	}
	if dialTimeout > managementDialTimeout {
		dialTimeout = managementDialTimeout
	}
	connection, err := net.DialTimeout("unix", socketPath, dialTimeout)
	if err != nil {
		return nil, err
	}
	session.connection = connection
	session.reader = bufio.NewReader(connection)
	session.connect.DialEnd = clock.Now()
	if err = connection.SetReadDeadline(deadline); err != nil {
		connection.Close()
		return nil, err
	}
	greeting, err := readManagementLine(session.reader)
	session.connect.GreetingEnd = clock.Now()
	if err != nil {
		connection.Close()
		return nil, err
	}
	if !strings.HasPrefix(greeting, ">INFO:") {
		connection.Close()
		return nil, fmt.Errorf("%w: unexpected greeting %q", errManagementProtocol, greeting)
	}
	return session, nil
}

func (session *managementSession) status(deadline time.Time) (managementStatusRead, error) {
	now := session.clock.Now()
	if !now.Before(deadline) {
		return managementStatusRead{Start: now, End: now}, fmt.Errorf("%w: status deadline", errManagementTimeout)
	}
	if err := session.connection.SetReadDeadline(deadline); err != nil {
		return managementStatusRead{Start: now, End: now}, err
	}
	if err := session.connection.SetWriteDeadline(deadline); err != nil {
		return managementStatusRead{Start: now, End: now}, err
	}
	start := session.clock.Now()
	if _, err := io.WriteString(session.connection, "status 3\n"); err != nil {
		return managementStatusRead{Start: start, End: session.clock.Now()}, managementIOError(err)
	}
	peers, err := parseStatusResponse(session.reader)
	end := session.clock.Now()
	return managementStatusRead{Peers: peers, Start: start, End: end}, err
}

func (session *managementSession) clientKill(clientID string, acceptDeadline time.Time) (managementCommandResult, error) {
	command, err := managementClientKillCommand(clientID)
	result := managementCommandResult{Command: command}
	if err != nil {
		return result, err
	}
	result.WriteStart = session.clock.Now()
	if !result.WriteStart.Before(acceptDeadline) {
		result.WriteEnd = result.WriteStart
		result.TerminalAt = result.WriteStart
		return result, ErrDisconnectNotAttempted
	}
	if err = session.connection.SetWriteDeadline(acceptDeadline); err != nil {
		return result, err
	}
	written, writeErr := io.WriteString(session.connection, command)
	result.BytesWritten = written
	result.Partial = written > 0 && written < len(command)
	if writeErr == nil && written != len(command) {
		writeErr = io.ErrShortWrite
	}
	if writeErr != nil {
		result.WriteEnd = session.clock.Now()
		result.TerminalAt = result.WriteEnd
		return result, managementIOError(writeErr)
	}
	// A successful write only means the order may have reached OpenVPN. A
	// later timeout/EOF is indeterminate and does not cancel the server's
	// scheduled exit; only a complete terminal line decides acceptance.
	result.Sent = true
	result.WriteEnd = session.clock.Now()
	if err = session.connection.SetReadDeadline(acceptDeadline); err != nil {
		return result, err
	}
	result.Terminal, result.TerminalLine, err = readManagementTerminal(session.reader)
	result.TerminalAt = session.clock.Now()
	return result, err
}

func managementIOError(err error) error {
	var networkErr net.Error
	if errors.As(err, &networkErr) && networkErr.Timeout() {
		return fmt.Errorf("%w: %v", errManagementTimeout, err)
	}
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: %v", errManagementEOF, err)
	}
	return err
}

// managementTransport is the protocol surface needed by the disconnect state
// machine. Tests can substitute a deterministic transport without sockets or
// real sleeps; production uses managementSession.
type managementTransport interface {
	status(deadline time.Time) (managementStatusRead, error)
	clientKill(clientID string, acceptDeadline time.Time) (managementCommandResult, error)
	Close() error
}

type disconnectOutcome struct {
	Attempted              bool
	Partial                bool
	Sent                   bool
	Accepted               bool
	Confirmed              bool
	AcceptWithinBudget     bool
	DisconnectWithinBudget bool
	Timings                RevocationTimings
}

// disconnectOpenVPNClient is the production disconnector. It only runs after
// the CRL rename has been published and refuses to use anything but a verified
// root-owned Unix socket in the target environment.
func disconnectOpenVPNClient(root, environmentID, deviceID string, t0 time.Time, clock managementClock) (disconnectOutcome, error) {
	if err := requireRootClient(os.Geteuid()); err != nil {
		return disconnectOutcome{}, err
	}
	return disconnectOpenVPNClientOnSocket(root, environmentID, deviceID, 0, 0, t0, clock)
}

// disconnectOpenVPNClientOnSocket is separated from the root gate so unit
// tests can exercise the protocol against a socket owned by the test user.
func disconnectOpenVPNClientOnSocket(root, environmentID, deviceID string, expectedUID, expectedGID uint32, t0 time.Time, clock managementClock) (disconnectOutcome, error) {
	var outcome disconnectOutcome
	if !ValidEnvironmentID(environmentID) {
		return outcome, errors.Join(ErrDisconnectNotAttempted, errors.New("invalid environment"))
	}
	expectedCN, err := managementExpectedCommonName(deviceID)
	if err != nil {
		return outcome, errors.Join(ErrDisconnectNotAttempted, err)
	}
	socketPath := filepath.Join(root, environmentID, managementSocketName)
	acceptDeadline := t0.Add(defaultManagementBudget.accept)
	session, err := openManagementSession(socketPath, expectedUID, expectedGID, acceptDeadline, clock)
	if err != nil {
		return outcome, errors.Join(ErrDisconnectNotAttempted, err)
	}
	defer session.Close()
	return disconnectWithTransport(session, session.connect, expectedCN, t0, clock, time.Sleep, defaultManagementBudget)
}

// disconnectWithTransport contains the ordered state machine. All deadlines
// are absolute T0-derived instants; sleep is injected so budget tests are
// deterministic.
func disconnectWithTransport(transport managementTransport, connect managementConnectTiming, expectedCN string, t0 time.Time, clock managementClock, sleep func(time.Duration), budget managementBudget) (disconnectOutcome, error) {
	var outcome disconnectOutcome
	acceptDeadline := t0.Add(budget.accept)
	totalDeadline := t0.Add(budget.total)
	outcome.Timings.ConnectStartNS = elapsedNS(t0, connect.Start)
	outcome.Timings.DialStartNS = elapsedNS(t0, connect.DialStart)
	outcome.Timings.DialEndNS = elapsedNS(t0, connect.DialEnd)
	outcome.Timings.GreetingEndNS = elapsedNS(t0, connect.GreetingEnd)

	if !clock.Now().Before(acceptDeadline) {
		return outcome, ErrDisconnectNotAttempted
	}
	initial, err := transport.status(acceptDeadline)
	outcome.Timings.InitialStatusStartNS = elapsedNS(t0, initial.Start)
	outcome.Timings.InitialStatusEndNS = elapsedNS(t0, initial.End)
	if err != nil {
		return outcome, errors.Join(ErrDisconnectNotAttempted, err)
	}
	target, err := selectTargetPeer(initial.Peers, expectedCN)
	if err != nil {
		return outcome, errors.Join(ErrDisconnectNotAttempted, err)
	}
	controls := controlPeers(initial.Peers, target)

	if !clock.Now().Before(acceptDeadline) {
		return outcome, ErrDisconnectNotAttempted
	}
	preKill, err := transport.status(acceptDeadline)
	outcome.Timings.PreKillStatusStartNS = elapsedNS(t0, preKill.Start)
	outcome.Timings.PreKillStatusEndNS = elapsedNS(t0, preKill.End)
	if err != nil {
		return outcome, errors.Join(ErrDisconnectNotAttempted, err)
	}
	preKillTarget, err := selectTargetPeer(preKill.Peers, expectedCN)
	if err != nil {
		return outcome, errors.Join(ErrDisconnectNotAttempted, err)
	}
	if !samePeerIdentity(target, preKillTarget) {
		return outcome, errors.Join(ErrDisconnectNotAttempted, errPeerIdentityChanged)
	}
	// Last possible observation point before the only write. If the
	// acceptance budget is gone, do not send and never use T0+total as
	// permission to write outside T0+accept.
	if !clock.Now().Before(acceptDeadline) {
		return outcome, ErrDisconnectNotAttempted
	}

	command, err := transport.clientKill(target.ClientID, acceptDeadline)
	outcome.Timings.KillWriteStartNS = elapsedNS(t0, command.WriteStart)
	outcome.Timings.KillWriteEndNS = elapsedNS(t0, command.WriteEnd)
	outcome.Timings.AcceptTerminalNS = elapsedNS(t0, command.TerminalAt)
	outcome.Sent = command.Sent
	outcome.Attempted = command.Sent || command.BytesWritten > 0
	outcome.Partial = command.Partial
	if err != nil {
		if outcome.Attempted {
			// A partial write or a write with an ambiguous error may have
			// reached management. Never classify it as not attempted.
			return outcome, errors.Join(ErrDisconnectUnconfirmed, err)
		}
		return outcome, errors.Join(ErrDisconnectNotAttempted, err)
	}
	switch command.Terminal {
	case managementTerminalError:
		return outcome, errors.Join(ErrDisconnectRejected, fmt.Errorf("%s", command.TerminalLine))
	case managementTerminalSuccess:
		// SUCCESS means the order was accepted/scheduled, never that the peer
		// is gone. Confirmation still requires the final status 3 below.
		outcome.Accepted = true
		acceptElapsed := command.TerminalAt.Sub(t0)
		outcome.Timings.AcceptElapsedNS = acceptElapsed.Nanoseconds()
		outcome.AcceptWithinBudget = acceptElapsed >= 0 && acceptElapsed <= budget.accept
	default:
		return outcome, errors.Join(ErrDisconnectUnconfirmed, fmt.Errorf("%w: terminal missing", errManagementIncomplete))
	}

	for {
		if !clock.Now().Before(totalDeadline) {
			return outcome, errors.Join(ErrDisconnectUnconfirmed, fmt.Errorf("%w: disconnect confirmation deadline", errManagementTimeout))
		}
		status, err := transport.status(totalDeadline)
		outcome.Timings.FinalStatusStartNS = elapsedNS(t0, status.Start)
		outcome.Timings.FinalStatusEndNS = elapsedNS(t0, status.End)
		outcome.Timings.FinalStatusPolls = append(outcome.Timings.FinalStatusPolls, RevocationStatusTiming{
			StartNS: outcome.Timings.FinalStatusStartNS,
			EndNS:   outcome.Timings.FinalStatusEndNS,
		})
		if err != nil {
			return outcome, errors.Join(ErrDisconnectUnconfirmed, err)
		}
		disconnectElapsed := status.End.Sub(t0)
		outcome.Timings.DisconnectElapsedNS = disconnectElapsed.Nanoseconds()
		if disconnectElapsed > budget.total {
			// A status that completes after T0+total is truthful evidence but
			// cannot be used to claim the SLA or a confirmed disconnect.
			return outcome, errors.Join(ErrDisconnectUnconfirmed, fmt.Errorf("%w: final status after total deadline", errManagementTimeout))
		}
		targetCount := countTargetPeers(status.Peers, expectedCN)
		if targetCount > 1 {
			return outcome, errors.Join(ErrDisconnectUnconfirmed, errPeerAmbiguous)
		}
		if targetCount == 0 {
			if len(controls) == 0 {
				// The approved T_caída definition requires a control peer to
				// remain present. Without one we cannot claim confirmation.
				return outcome, errors.Join(ErrDisconnectUnconfirmed, errControlPeerUnavailable)
			}
			if !controlPeerPresent(status.Peers, controls) {
				return outcome, errors.Join(ErrDisconnectUnconfirmed, errControlPeerLost)
			}
			outcome.Confirmed = true
			outcome.DisconnectWithinBudget = disconnectElapsed <= budget.total
			return outcome, nil
		}
		currentTarget, selectErr := selectTargetPeer(status.Peers, expectedCN)
		if selectErr != nil {
			return outcome, errors.Join(ErrDisconnectUnconfirmed, selectErr)
		}
		if !samePeerIdentity(currentTarget, target) {
			// A new session for the revoked CN must not be hidden behind the
			// old one: stop with evidence instead of polling to the deadline.
			return outcome, errors.Join(ErrDisconnectUnconfirmed, errPeerIdentityChanged)
		}
		if len(controls) > 0 && !controlPeerPresent(status.Peers, controls) {
			return outcome, errors.Join(ErrDisconnectUnconfirmed, errControlPeerLost)
		}
		wait := budget.poll
		if remaining := totalDeadline.Sub(clock.Now()); remaining < wait {
			wait = remaining
		}
		if wait <= 0 {
			return outcome, errors.Join(ErrDisconnectUnconfirmed, fmt.Errorf("%w: disconnect confirmation deadline", errManagementTimeout))
		}
		sleep(wait)
	}
}
