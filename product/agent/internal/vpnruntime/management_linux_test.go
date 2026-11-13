//go:build linux

package vpnruntime

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const managementControlCN = "nexo:22222222-2222-4222-8222-222222222222"

const fakeManagementGreeting = ">INFO:OpenVPN Management Interface Version 5 -- type 'help' for more info\r\n"

func TestManagementClientKillCommandUsesOnlyUnsignedLongClientID(t *testing.T) {
	// OpenVPN 2.6.14 manage.c parses "%lu" into unsigned long; the supported
	// Linux amd64/arm64 builds have a 64-bit unsigned long.
	for _, valid := range []string{
		"0",
		"1",
		"2147483647",
		"2147483648",           // 2^31
		"4294967296",           // 2^32
		"18446744073709551615", // MaxUint64
	} {
		command, err := managementClientKillCommand(valid)
		if err != nil {
			t.Fatalf("valid client id %q rejected: %v", valid, err)
		}
		if command != "client-kill "+valid+"\n" {
			t.Fatalf("unexpected management command %q", command)
		}
	}
	for _, invalid := range []string{
		"", "nexo:" + testDevice, "0\nclient-kill 1", "0 1", "-1", "+1", "0x10",
		"00", "0001",
		"18446744073709551616",    // 2^64 overflow
		"99999999999999999999999", // far beyond unsigned long
	} {
		if _, err := managementClientKillCommand(invalid); err == nil {
			t.Fatalf("invalid client id accepted: %q", invalid)
		}
	}
}

func TestRootManagementClientGate(t *testing.T) {
	if err := requireRootClient(0); err != nil {
		t.Fatalf("root client rejected: %v", err)
	}
	for _, uid := range []int{1, 1000, 65534} {
		if err := requireRootClient(uid); err == nil {
			t.Fatalf("non-root client uid %d accepted", uid)
		}
	}
}

func TestPrepareManagementSocketRequiresSocketOwnedByExpectedIdentity(t *testing.T) {
	directory := t.TempDir()
	socketPath := filepath.Join(directory, "mgmt.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	if err = prepareManagementSocket(socketPath, uid, gid); err != nil {
		t.Fatalf("valid socket rejected: %v", err)
	}
	info, statErr := os.Stat(socketPath)
	if statErr != nil {
		t.Fatalf("cannot stat tightened socket: %v", statErr)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("socket was not tightened to 0600: mode=%o", info.Mode().Perm())
	}
	if err = prepareManagementSocket(socketPath, uid+1, gid); err == nil {
		t.Fatal("socket with unexpected owner was accepted")
	}
}

func TestPrepareManagementSocketRejectsRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mgmt.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareManagementSocket(path, uint32(os.Geteuid()), uint32(os.Getegid())); err == nil {
		t.Fatal("regular file was accepted as a management socket")
	}
}

func TestReadManagementTerminalOnlyCompleteTerminalIsAcceptance(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		terminal  managementTerminal
		targetErr error
	}{
		{
			name:     "success after interleaved log events",
			raw:      ">LOG:1,D,MANAGEMENT: CMD 'client-kill 0'\r\n>LOG:1,,Delayed exit in 5 seconds\r\n>LOG:1,,SENT CONTROL [x]: 'RESTART' (status=1)\r\nSUCCESS: client-kill command succeeded\r\n",
			terminal: managementTerminalSuccess,
		},
		{
			name:     "error terminal",
			raw:      ">LOG:1,D,MANAGEMENT: CMD 'client-kill 9'\r\nERROR: client-kill command failed\r\n",
			terminal: managementTerminalError,
		},
		{
			name:      "eof without terminal",
			raw:       ">LOG:1,D,MANAGEMENT: CMD 'client-kill 0'\r\n",
			targetErr: errManagementEOF,
		},
		{
			name:      "partial terminal without newline",
			raw:       "SUCCESS: client-kill command succeeded",
			targetErr: errManagementIncomplete,
		},
		{
			name:      "unknown frame",
			raw:       "unexpected\r\n",
			targetErr: errManagementProtocol,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			terminal, _, err := readManagementTerminal(bufio.NewReader(strings.NewReader(testCase.raw)))
			if testCase.targetErr != nil {
				if !errors.Is(err, testCase.targetErr) {
					t.Fatalf("unexpected error %v, want %v", err, testCase.targetErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if terminal != testCase.terminal {
				t.Fatalf("unexpected terminal %v", terminal)
			}
		})
	}
}

func TestReadManagementTerminalTimeoutIsNotAcceptance(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	if err := server.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	go func() {
		_, _ = io.WriteString(client, ">LOG:1,D,MANAGEMENT: CMD 'client-kill 0'\r\n")
		time.Sleep(200 * time.Millisecond)
		client.Close()
	}()
	terminal, _, err := readManagementTerminal(bufio.NewReader(server))
	if !errors.Is(err, errManagementTimeout) {
		t.Fatalf("timeout was not detected: %v", err)
	}
	if terminal != managementTerminalNone {
		t.Fatalf("timeout produced a terminal %v", terminal)
	}
}

func TestParseStatusResponseInterleavedAndColumns(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	raw := ">LOG:1,D,before status\r\n" +
		"TITLE\tOpenVPN 2.6.14\r\n" +
		managementClientListHeader() +
		">LOG:1,D,between peers\r\n" +
		target + "\r\n" +
		control + "\r\n" +
		"HEADER\tROUTING_TABLE\tVirtual Address\tCommon Name\tReal Address\tLast Ref\tLast Ref (time_t)\r\n" +
		">LOG:1,D,before end\r\n" +
		"GLOBAL_STATS\tdco_enabled\t0\r\n" +
		"END\r\n"
	peers, err := parseStatusResponse(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 2 {
		t.Fatalf("unexpected peers: %#v", peers)
	}
	if peers[0].CommonName != "nexo:"+testDevice || peers[0].RealAddress != "127.0.0.1:53832" || peers[0].ClientID != "0" || peers[0].PeerID != "0" {
		t.Fatalf("target columns were not parsed: %#v", peers[0])
	}
	if peers[1].CommonName != managementControlCN || peers[1].ClientID != "1" || peers[1].PeerID != "1" {
		t.Fatalf("control columns were not parsed: %#v", peers[1])
	}
}

func TestParseStatusResponseRejectsIncompleteAndMalformedFrames(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	duplicateHeader := managementClientListHeader() + managementClientListHeader()
	duplicateColumnHeader := "HEADER\tCLIENT_LIST\tCommon Name\tCommon Name\tReal Address\tClient ID\tPeer ID\r\n"
	cases := []struct {
		name string
		raw  string
	}{
		{name: "missing END", raw: managementClientListHeader() + target + "\r\n"},
		{name: "short row", raw: managementClientListHeader() + "CLIENT_LIST\tnexo:" + testDevice + "\r\nEND\r\n"},
		{name: "row before header", raw: target + "\r\nEND\r\n"},
		{name: "unknown frame", raw: managementClientListHeader() + "UNEXPECTED\tvalue\r\nEND\r\n"},
		{name: "duplicate header", raw: duplicateHeader + target + "\r\nEND\r\n"},
		{name: "duplicate column", raw: duplicateColumnHeader + target + "\r\nEND\r\n"},
		{name: "END before header", raw: "END\r\n"},
		{name: "malformed END", raw: managementClientListHeader() + target + "\r\nEND\textra\r\n"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := parseStatusResponse(bufio.NewReader(strings.NewReader(testCase.raw))); err == nil {
				t.Fatal("malformed status was accepted")
			}
		})
	}
}

func TestParseStatusResponseDoesNotNormalizePaddedCommonName(t *testing.T) {
	padded := managementPeerRow(" nexo:"+testDevice+" ", "127.0.0.1:53832", "0", "0")
	peers, err := parseStatusResponse(bufio.NewReader(strings.NewReader(managementClientListHeader() + padded + "\r\nEND\r\n")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = selectTargetPeer(peers, "nexo:"+testDevice); !errors.Is(err, errPeerNotFound) {
		t.Fatalf("padded common name matched the exact target: %v", err)
	}
}

func TestSelectTargetPeerRequiresExactlyOneExactCommonName(t *testing.T) {
	target := managementPeer{CommonName: "nexo:" + testDevice, RealAddress: "127.0.0.1:1", ClientID: "0", PeerID: "0"}
	other := managementPeer{CommonName: managementControlCN, RealAddress: "127.0.0.1:2", ClientID: "1", PeerID: "1"}
	if got, err := selectTargetPeer([]managementPeer{other, target}, target.CommonName); err != nil || !samePeerIdentity(got, target) {
		t.Fatalf("unique target was not selected: %#v %v", got, err)
	}
	if _, err := selectTargetPeer([]managementPeer{other}, target.CommonName); !errors.Is(err, errPeerNotFound) {
		t.Fatalf("zero matches did not fail closed: %v", err)
	}
	duplicate := target
	duplicate.ClientID = "9"
	if _, err := selectTargetPeer([]managementPeer{target, duplicate}, target.CommonName); !errors.Is(err, errPeerAmbiguous) {
		t.Fatalf("multiple matches did not fail closed: %v", err)
	}
}

func TestSamePeerIdentityCoversCNCIDPeerIDAndEndpoint(t *testing.T) {
	base := managementPeer{CommonName: "nexo:" + testDevice, RealAddress: "127.0.0.1:53832", ClientID: "0", PeerID: "0"}
	changes := []managementPeer{
		{CommonName: managementControlCN, RealAddress: base.RealAddress, ClientID: base.ClientID, PeerID: base.PeerID},
		{CommonName: base.CommonName, RealAddress: "127.0.0.1:53833", ClientID: base.ClientID, PeerID: base.PeerID},
		{CommonName: base.CommonName, RealAddress: base.RealAddress, ClientID: "1", PeerID: base.PeerID},
		{CommonName: base.CommonName, RealAddress: base.RealAddress, ClientID: base.ClientID, PeerID: "1"},
	}
	if !samePeerIdentity(base, base) {
		t.Fatal("identical peer identity was rejected")
	}
	for _, changed := range changes {
		if samePeerIdentity(base, changed) {
			t.Fatalf("identity change was ignored: %#v", changed)
		}
	}
}

func TestElapsedNSUsesInjectedMonotonicValues(t *testing.T) {
	start := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	if got := elapsedNS(start, start.Add(1500*time.Millisecond)); got != int64(1500*time.Millisecond) {
		t.Fatalf("unexpected elapsed %d", got)
	}
	if got := elapsedNS(start, start.Add(-time.Millisecond)); got != 0 {
		t.Fatalf("backwards elapsed was not clamped: %d", got)
	}
	if got := elapsedNS(start, start.Add(2000*time.Millisecond+900*time.Microsecond)); got <= int64(2000*time.Millisecond) {
		t.Fatalf("sub-millisecond over-budget duration was truncated: %d", got)
	}
}

type fakeManagementClock struct {
	mu   sync.Mutex
	now  time.Time
	step time.Duration
}

func newFakeManagementClock() *fakeManagementClock {
	return &fakeManagementClock{now: time.Now()}
}

func (clock *fakeManagementClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	current := clock.now
	clock.now = clock.now.Add(clock.step)
	return current
}

func (clock *fakeManagementClock) setStep(step time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.step = step
}

func (clock *fakeManagementClock) advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(duration)
}

type scriptedManagementClock struct {
	times []time.Time
	index int
}

func (clock *scriptedManagementClock) Now() time.Time {
	if clock.index >= len(clock.times) {
		return clock.times[len(clock.times)-1]
	}
	value := clock.times[clock.index]
	clock.index++
	return value
}

type fakeManagementServer struct {
	root string
	done <-chan error
}

func startFakeManagementServer(t *testing.T, handler func(*bufio.Reader, net.Conn) error) *fakeManagementServer {
	t.Helper()
	root, err := os.MkdirTemp("", "mv8-")
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, testEnvironment)
	if err = os.MkdirAll(directory, 0700); err != nil {
		_ = os.RemoveAll(root)
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(directory, managementSocketName))
	if err != nil {
		_ = os.RemoveAll(root)
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		defer listener.Close()
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			done <- acceptErr
			return
		}
		defer connection.Close()
		done <- handler(bufio.NewReader(connection), connection)
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.RemoveAll(root)
	})
	return &fakeManagementServer{root: root, done: done}
}

func readFakeCommand(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}

func writeFake(connection net.Conn, contents string) error {
	_, err := io.WriteString(connection, contents)
	return err
}

func realDisconnect(t *testing.T, root string) (disconnectOutcome, error) {
	t.Helper()
	clock := systemManagementClock{}
	return disconnectOpenVPNClientOnSocket(root, testEnvironment, testDevice, uint32(os.Geteuid()), uint32(os.Getegid()), clock.Now(), clock)
}

func TestDisconnectUsesStatusIdentityAndConfirmsFinalStatus(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	var killCommands atomic.Int32
	server := startFakeManagementServer(t, func(reader *bufio.Reader, connection net.Conn) error {
		if err := writeFake(connection, fakeManagementGreeting); err != nil {
			return err
		}
		for index := 0; index < 2; index++ {
			command, err := readFakeCommand(reader)
			if err != nil {
				return err
			}
			if command != "status 3" {
				return fmt.Errorf("unexpected command %q", command)
			}
			if err = writeFake(connection, managementStatusFrame(target, control)); err != nil {
				return err
			}
		}
		command, err := readFakeCommand(reader)
		if err != nil {
			return err
		}
		if command != "client-kill 0" {
			return fmt.Errorf("unexpected kill command %q", command)
		}
		killCommands.Add(1)
		if err = writeFake(connection, ">LOG:1,D,MANAGEMENT: CMD 'client-kill 0'\r\n>LOG:1,,Delayed exit in 5 seconds\r\n>LOG:1,,SENT CONTROL [nexo:"+testDevice+"]: 'RESTART' (status=1)\r\nSUCCESS: client-kill command succeeded\r\n"); err != nil {
			return err
		}
		command, err = readFakeCommand(reader)
		if err != nil {
			return err
		}
		if command != "status 3" {
			return fmt.Errorf("unexpected first final status %q", command)
		}
		if err = writeFake(connection, managementStatusFrame(target, control)); err != nil {
			return err
		}
		command, err = readFakeCommand(reader)
		if err != nil {
			return err
		}
		if command != "status 3" {
			return fmt.Errorf("unexpected second final status %q", command)
		}
		return writeFake(connection, managementStatusFrame(control))
	})

	outcome, err := realDisconnect(t, server.root)
	if err != nil {
		t.Fatal(err)
	}
	if !outcome.Sent || !outcome.Accepted || !outcome.Confirmed {
		t.Fatalf("disconnect was not confirmed: %#v", outcome)
	}
	if !outcome.AcceptWithinBudget || !outcome.DisconnectWithinBudget {
		t.Fatalf("SLA flags were not set: %#v", outcome)
	}
	if killCommands.Load() != 1 {
		t.Fatalf("client-kill was sent %d times", killCommands.Load())
	}
	if outcome.Timings.AcceptElapsedNS <= 0 || outcome.Timings.AcceptElapsedNS > int64(managementAcceptBudget) {
		t.Fatalf("accept elapsed outside budget: %#v", outcome.Timings)
	}
	if outcome.Timings.DisconnectElapsedNS < outcome.Timings.AcceptElapsedNS {
		t.Fatalf("disconnect elapsed precedes acceptance: %#v", outcome.Timings)
	}
	if outcome.Timings.InitialStatusEndNS > outcome.Timings.PreKillStatusStartNS {
		t.Fatalf("status stages are not ordered: %#v", outcome.Timings)
	}
	if err = <-server.done; err != nil {
		t.Fatalf("fake management server failed: %v", err)
	}
}

func TestDisconnectAbortsWithoutCommandWhenPreReadIdentityChanges(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	changed := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "9", "0")
	var killCommands atomic.Int32
	server := startFakeManagementServer(t, func(reader *bufio.Reader, connection net.Conn) error {
		if err := writeFake(connection, fakeManagementGreeting); err != nil {
			return err
		}
		if _, err := readFakeCommand(reader); err != nil {
			return err
		}
		if err := writeFake(connection, managementStatusFrame(target, control)); err != nil {
			return err
		}
		if _, err := readFakeCommand(reader); err != nil {
			return err
		}
		if err := writeFake(connection, managementStatusFrame(changed, control)); err != nil {
			return err
		}
		command, err := readFakeCommand(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if strings.HasPrefix(command, "client-kill") {
			killCommands.Add(1)
		}
		return fmt.Errorf("unexpected command after identity mismatch %q", command)
	})

	outcome, err := realDisconnect(t, server.root)
	if !errors.Is(err, ErrDisconnectNotAttempted) || !errors.Is(err, errPeerIdentityChanged) {
		t.Fatalf("identity change was not rejected as not attempted: %v", err)
	}
	if outcome.Sent || outcome.Accepted || outcome.Confirmed {
		t.Fatalf("identity change produced a disconnect result: %#v", outcome)
	}
	if killCommands.Load() != 0 {
		t.Fatalf("client-kill was sent after identity change")
	}
	if serverErr := <-server.done; serverErr != nil {
		t.Fatalf("fake management server failed: %v", serverErr)
	}
}

func TestDisconnectFailsClosedOnZeroOrMultipleMatches(t *testing.T) {
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	duplicate := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53833", "2", "2")
	cases := []struct {
		name      string
		peers     []string
		targetErr error
	}{
		{name: "zero matches", peers: []string{control}, targetErr: errPeerNotFound},
		{name: "multiple matches", peers: []string{target, duplicate, control}, targetErr: errPeerAmbiguous},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var killCommands atomic.Int32
			server := startFakeManagementServer(t, func(reader *bufio.Reader, connection net.Conn) error {
				if err := writeFake(connection, fakeManagementGreeting); err != nil {
					return err
				}
				if _, err := readFakeCommand(reader); err != nil {
					return err
				}
				if err := writeFake(connection, managementStatusFrame(testCase.peers...)); err != nil {
					return err
				}
				command, err := readFakeCommand(reader)
				if err != nil {
					if errors.Is(err, io.EOF) {
						return nil
					}
					return err
				}
				if strings.HasPrefix(command, "client-kill") {
					killCommands.Add(1)
				}
				return fmt.Errorf("unexpected command after selection failure %q", command)
			})
			outcome, err := realDisconnect(t, server.root)
			if !errors.Is(err, ErrDisconnectNotAttempted) || !errors.Is(err, testCase.targetErr) {
				t.Fatalf("unexpected error %v, want not attempted + %v", err, testCase.targetErr)
			}
			if outcome.Sent || outcome.Accepted || outcome.Confirmed {
				t.Fatalf("ambiguous selection produced a disconnect result: %#v", outcome)
			}
			if killCommands.Load() != 0 {
				t.Fatal("client-kill was sent after failed target selection")
			}
			if serverErr := <-server.done; serverErr != nil {
				t.Fatalf("fake management server failed: %v", serverErr)
			}
		})
	}
}

func TestDisconnectTerminalErrorIsRejectionNotAcceptance(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	var killCommands atomic.Int32
	server := startFakeManagementServer(t, func(reader *bufio.Reader, connection net.Conn) error {
		if err := writeFake(connection, fakeManagementGreeting); err != nil {
			return err
		}
		for index := 0; index < 2; index++ {
			if _, err := readFakeCommand(reader); err != nil {
				return err
			}
			if err := writeFake(connection, managementStatusFrame(target, control)); err != nil {
				return err
			}
		}
		if _, err := readFakeCommand(reader); err != nil {
			return err
		}
		killCommands.Add(1)
		return writeFake(connection, ">LOG:1,D,MANAGEMENT: CMD 'client-kill 0'\r\nERROR: client-kill command failed\r\n")
	})

	outcome, err := realDisconnect(t, server.root)
	if !errors.Is(err, ErrDisconnectRejected) {
		t.Fatalf("ERROR terminal was not a rejection: %v", err)
	}
	if !outcome.Sent || outcome.Accepted || outcome.Confirmed {
		t.Fatalf("ERROR terminal produced the wrong outcome: %#v", outcome)
	}
	if killCommands.Load() != 1 {
		t.Fatalf("client-kill was sent %d times", killCommands.Load())
	}
	if serverErr := <-server.done; serverErr != nil {
		t.Fatalf("fake management server failed: %v", serverErr)
	}
}

func TestDisconnectEOFBeforeTerminalIsNotAcceptance(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	server := startFakeManagementServer(t, func(reader *bufio.Reader, connection net.Conn) error {
		if err := writeFake(connection, fakeManagementGreeting); err != nil {
			return err
		}
		for index := 0; index < 2; index++ {
			if _, err := readFakeCommand(reader); err != nil {
				return err
			}
			if err := writeFake(connection, managementStatusFrame(target, control)); err != nil {
				return err
			}
		}
		if _, err := readFakeCommand(reader); err != nil {
			return err
		}
		return nil
	})

	outcome, err := realDisconnect(t, server.root)
	if !errors.Is(err, ErrDisconnectUnconfirmed) {
		t.Fatalf("EOF was not reported as unconfirmed: %v", err)
	}
	if !outcome.Sent || outcome.Accepted || outcome.Confirmed {
		t.Fatalf("EOF produced acceptance: %#v", outcome)
	}
	if serverErr := <-server.done; serverErr != nil {
		t.Fatalf("fake management server failed: %v", serverErr)
	}
}

func TestDisconnectStopsWhenFinalStatusShowsChangedTargetSession(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	changed := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53833", "9", "9")
	var killCommands atomic.Int32
	server := startFakeManagementServer(t, func(reader *bufio.Reader, connection net.Conn) error {
		if err := writeFake(connection, fakeManagementGreeting); err != nil {
			return err
		}
		for index := 0; index < 2; index++ {
			if _, err := readFakeCommand(reader); err != nil {
				return err
			}
			if err := writeFake(connection, managementStatusFrame(target, control)); err != nil {
				return err
			}
		}
		if _, err := readFakeCommand(reader); err != nil {
			return err
		}
		killCommands.Add(1)
		if err := writeFake(connection, "SUCCESS: client-kill command succeeded\r\n"); err != nil {
			return err
		}
		if _, err := readFakeCommand(reader); err != nil {
			return err
		}
		return writeFake(connection, managementStatusFrame(changed, control))
	})

	outcome, err := realDisconnect(t, server.root)
	if !errors.Is(err, ErrDisconnectUnconfirmed) {
		t.Fatalf("changed final target session was not rejected: %v", err)
	}
	if !outcome.Sent || !outcome.Accepted || outcome.Confirmed {
		t.Fatalf("changed final session produced the wrong outcome: %#v", outcome)
	}
	if killCommands.Load() != 1 {
		t.Fatalf("client-kill was sent %d times", killCommands.Load())
	}
	if serverErr := <-server.done; serverErr != nil {
		t.Fatalf("fake management server failed: %v", serverErr)
	}
}

func TestDisconnectRequiresControlPeerForConfirmation(t *testing.T) {
	target := managementPeerRow("nexo:"+testDevice, "127.0.0.1:53832", "0", "0")
	control := managementPeerRow(managementControlCN, "127.0.0.1:44472", "1", "1")
	cases := []struct {
		name    string
		initial []string
		final   []string
	}{
		{name: "no control peer initially", initial: []string{target}, final: []string{}},
		{name: "control peer lost", initial: []string{target, control}, final: []string{target}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := startFakeManagementServer(t, func(reader *bufio.Reader, connection net.Conn) error {
				if err := writeFake(connection, fakeManagementGreeting); err != nil {
					return err
				}
				for index := 0; index < 2; index++ {
					if _, err := readFakeCommand(reader); err != nil {
						return err
					}
					if err := writeFake(connection, managementStatusFrame(testCase.initial...)); err != nil {
						return err
					}
				}
				if _, err := readFakeCommand(reader); err != nil {
					return err
				}
				if err := writeFake(connection, "SUCCESS: client-kill command succeeded\r\n"); err != nil {
					return err
				}
				if _, err := readFakeCommand(reader); err != nil {
					return err
				}
				return writeFake(connection, managementStatusFrame(testCase.final...))
			})
			outcome, err := realDisconnect(t, server.root)
			if !errors.Is(err, ErrDisconnectUnconfirmed) {
				t.Fatalf("control failure was not unconfirmed: %v", err)
			}
			if !outcome.Sent || !outcome.Accepted || outcome.Confirmed {
				t.Fatalf("control failure produced the wrong outcome: %#v", outcome)
			}
			if serverErr := <-server.done; serverErr != nil {
				t.Fatalf("fake management server failed: %v", serverErr)
			}
		})
	}
}

type fakeStatusStep struct {
	peers   []managementPeer
	err     error
	advance time.Duration
}

type fakeManagementTransport struct {
	clock       *fakeManagementClock
	statuses    []fakeStatusStep
	statusCalls int
	kill        managementCommandResult
	killErr     error
	killCalls   int
}

func (transport *fakeManagementTransport) status(time.Time) (managementStatusRead, error) {
	index := transport.statusCalls
	if index >= len(transport.statuses) {
		index = len(transport.statuses) - 1
	}
	step := transport.statuses[index]
	transport.statusCalls++
	start := transport.clock.Now()
	if step.advance > 0 {
		transport.clock.advance(step.advance)
	}
	end := transport.clock.Now()
	return managementStatusRead{Peers: step.peers, Start: start, End: end}, step.err
}

func (transport *fakeManagementTransport) clientKill(clientID string, _ time.Time) (managementCommandResult, error) {
	transport.killCalls++
	result := transport.kill
	result.Command = "client-kill " + clientID + "\n"
	if result.WriteStart.IsZero() {
		result.WriteStart = transport.clock.Now()
	}
	if result.WriteEnd.IsZero() {
		result.WriteEnd = transport.clock.Now()
	}
	if result.TerminalAt.IsZero() {
		result.TerminalAt = transport.clock.Now()
	}
	return result, transport.killErr
}

func (transport *fakeManagementTransport) Close() error { return nil }

func fakePeers() (managementPeer, managementPeer) {
	return managementPeer{CommonName: "nexo:" + testDevice, RealAddress: "127.0.0.1:53832", ClientID: "0", PeerID: "0"},
		managementPeer{CommonName: managementControlCN, RealAddress: "127.0.0.1:44472", ClientID: "1", PeerID: "1"}
}

func TestDisconnectDoesNotWriteWhenAcceptanceBudgetIsExhausted(t *testing.T) {
	target, control := fakePeers()
	clock := newFakeManagementClock()
	t0 := clock.Now()
	transport := &fakeManagementTransport{
		clock: clock,
		statuses: []fakeStatusStep{
			{peers: []managementPeer{target, control}, advance: managementAcceptBudget + time.Millisecond},
			{peers: []managementPeer{target, control}},
		},
		kill: managementCommandResult{Terminal: managementTerminalSuccess, Sent: true},
	}
	outcome, err := disconnectWithTransport(transport, managementConnectTiming{}, "nexo:"+testDevice, t0, clock, func(time.Duration) {}, managementBudget{
		accept: managementAcceptBudget,
		total:  managementTotalBudget,
		poll:   time.Millisecond,
	})
	if !errors.Is(err, ErrDisconnectNotAttempted) {
		t.Fatalf("expired acceptance budget did not fail closed: %v", err)
	}
	if outcome.Sent || outcome.Accepted || outcome.Confirmed {
		t.Fatalf("expired budget produced a command result: %#v", outcome)
	}
	if transport.killCalls != 0 {
		t.Fatalf("client-kill was emitted after the acceptance budget: %d", transport.killCalls)
	}
}

func TestDisconnectRegistersLateAcceptanceWithoutBudgetPass(t *testing.T) {
	target, control := fakePeers()
	clock := newFakeManagementClock()
	t0 := clock.Now()
	accept := 100 * time.Millisecond
	transport := &fakeManagementTransport{
		clock: clock,
		statuses: []fakeStatusStep{
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{control}},
		},
		kill: managementCommandResult{
			Sent:       true,
			WriteStart: t0.Add(10 * time.Millisecond),
			WriteEnd:   t0.Add(20 * time.Millisecond),
			TerminalAt: t0.Add(accept + 50*time.Millisecond),
			Terminal:   managementTerminalSuccess,
		},
	}
	outcome, err := disconnectWithTransport(transport, managementConnectTiming{}, "nexo:"+testDevice, t0, clock, func(time.Duration) {}, managementBudget{
		accept: accept,
		total:  300 * time.Millisecond,
		poll:   time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !outcome.Sent || !outcome.Accepted || !outcome.Confirmed {
		t.Fatalf("late acceptance was not registered: %#v", outcome)
	}
	if outcome.AcceptWithinBudget {
		t.Fatalf("late acceptance incorrectly passed the SLA: %#v", outcome.Timings)
	}
	if outcome.Timings.AcceptElapsedNS != int64(accept+50*time.Millisecond) {
		t.Fatalf("late acceptance time was not truthful: %#v", outcome.Timings)
	}
	if !outcome.DisconnectWithinBudget {
		t.Fatalf("disconnect confirmation should be within total budget: %#v", outcome.Timings)
	}
}

func TestDisconnectRejectsFinalStatusAfterTotalBudget(t *testing.T) {
	target, control := fakePeers()
	clock := newFakeManagementClock()
	t0 := clock.Now()
	total := 200 * time.Millisecond
	transport := &fakeManagementTransport{
		clock: clock,
		statuses: []fakeStatusStep{
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{control}, advance: total + time.Millisecond},
		},
		kill: managementCommandResult{
			Sent:       true,
			WriteStart: t0.Add(10 * time.Millisecond),
			WriteEnd:   t0.Add(20 * time.Millisecond),
			TerminalAt: t0.Add(30 * time.Millisecond),
			Terminal:   managementTerminalSuccess,
		},
	}
	outcome, err := disconnectWithTransport(transport, managementConnectTiming{}, "nexo:"+testDevice, t0, clock, func(time.Duration) {}, managementBudget{
		accept: 100 * time.Millisecond,
		total:  total,
		poll:   time.Millisecond,
	})
	if !errors.Is(err, ErrDisconnectUnconfirmed) {
		t.Fatalf("late final status was not rejected: %v", err)
	}
	if !outcome.Accepted || outcome.Confirmed || outcome.DisconnectWithinBudget {
		t.Fatalf("late final status produced a false PASS: %#v", outcome)
	}
	if outcome.Timings.DisconnectElapsedNS <= int64(total) {
		t.Fatalf("late final status time was truncated: %#v", outcome.Timings)
	}
}

func TestDisconnectSLAExactBoundaries(t *testing.T) {
	target, control := fakePeers()
	cases := []struct {
		name          string
		terminalAt    time.Duration
		finalAdvance  time.Duration
		wantAccept    bool
		wantConfirmed bool
	}{
		{name: "accept exactly 2s", terminalAt: 2 * time.Second, finalAdvance: 0, wantAccept: true, wantConfirmed: true},
		{name: "accept 2s plus 1ns", terminalAt: 2*time.Second + time.Nanosecond, finalAdvance: 0, wantAccept: false, wantConfirmed: true},
		{name: "disconnect exactly 10s", terminalAt: time.Millisecond, finalAdvance: 10 * time.Second, wantAccept: true, wantConfirmed: true},
		{name: "disconnect 10s plus 1ns", terminalAt: time.Millisecond, finalAdvance: 10*time.Second + time.Nanosecond, wantAccept: true, wantConfirmed: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			clock := newFakeManagementClock()
			t0 := clock.Now()
			transport := &fakeManagementTransport{
				clock: clock,
				statuses: []fakeStatusStep{
					{peers: []managementPeer{target, control}},
					{peers: []managementPeer{target, control}},
					{peers: []managementPeer{control}, advance: testCase.finalAdvance},
				},
				kill: managementCommandResult{
					Sent:       true,
					WriteStart: t0,
					WriteEnd:   t0,
					TerminalAt: t0.Add(testCase.terminalAt),
					Terminal:   managementTerminalSuccess,
				},
			}
			outcome, err := disconnectWithTransport(transport, managementConnectTiming{}, "nexo:"+testDevice, t0, clock, func(time.Duration) {}, managementBudget{
				accept: 2 * time.Second,
				total:  10 * time.Second,
				poll:   time.Millisecond,
			})
			if testCase.wantConfirmed {
				if err != nil {
					t.Fatalf("expected confirmation: %v", err)
				}
				if !outcome.Confirmed || !outcome.DisconnectWithinBudget {
					t.Fatalf("confirmation flags missing: %#v", outcome)
				}
			} else {
				if !errors.Is(err, ErrDisconnectUnconfirmed) || outcome.Confirmed {
					t.Fatalf("late final status was accepted: err=%v outcome=%#v", err, outcome)
				}
			}
			if outcome.AcceptWithinBudget != testCase.wantAccept {
				t.Fatalf("accept boundary mismatch: %#v", outcome)
			}
			if outcome.Timings.AcceptElapsedNS != testCase.terminalAt.Nanoseconds() {
				t.Fatalf("accept timestamp was truncated: %#v", outcome.Timings)
			}
			if testCase.finalAdvance > 0 && outcome.Timings.DisconnectElapsedNS != testCase.finalAdvance.Nanoseconds() {
				t.Fatalf("disconnect timestamp was truncated: %#v", outcome.Timings)
			}
		})
	}
}

func TestFullWriteWithErrorIsIndeterminate(t *testing.T) {
	target, control := fakePeers()
	clock := newFakeManagementClock()
	t0 := clock.Now()
	command, err := managementClientKillCommand("0")
	if err != nil {
		t.Fatal(err)
	}
	transport := &fakeManagementTransport{
		clock: clock,
		statuses: []fakeStatusStep{
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{target, control}},
		},
		kill:    managementCommandResult{BytesWritten: len(command), Sent: false, Partial: false},
		killErr: errors.New("full write reported error"),
	}
	outcome, err := disconnectWithTransport(transport, managementConnectTiming{}, "nexo:"+testDevice, t0, clock, func(time.Duration) {}, managementBudget{
		accept: 100 * time.Millisecond,
		total:  300 * time.Millisecond,
		poll:   time.Millisecond,
	})
	if !errors.Is(err, ErrDisconnectUnconfirmed) || errors.Is(err, ErrDisconnectNotAttempted) {
		t.Fatalf("full write with error was misclassified: %v", err)
	}
	if !outcome.Attempted || outcome.Sent || outcome.Partial || outcome.Accepted || outcome.Confirmed {
		t.Fatalf("full write with error produced the wrong outcome: %#v", outcome)
	}
	if transport.killCalls != 1 {
		t.Fatalf("client-kill was attempted %d times", transport.killCalls)
	}
}

func TestDisconnectStopsWithoutRepeatingKillOnExpiry(t *testing.T) {
	target, control := fakePeers()
	clock := newFakeManagementClock()
	t0 := clock.Now()
	transport := &fakeManagementTransport{
		clock: clock,
		statuses: []fakeStatusStep{
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{target, control}},
		},
		kill: managementCommandResult{
			Sent:       true,
			WriteStart: t0.Add(10 * time.Millisecond),
			WriteEnd:   t0.Add(20 * time.Millisecond),
			TerminalAt: t0.Add(30 * time.Millisecond),
			Terminal:   managementTerminalSuccess,
		},
	}
	outcome, err := disconnectWithTransport(transport, managementConnectTiming{}, "nexo:"+testDevice, t0, clock, func(duration time.Duration) {
		clock.advance(duration)
	}, managementBudget{
		accept: 100 * time.Millisecond,
		total:  300 * time.Millisecond,
		poll:   50 * time.Millisecond,
	})
	if !errors.Is(err, ErrDisconnectUnconfirmed) {
		t.Fatalf("final status expiry was not reported: %v", err)
	}
	if !outcome.Sent || !outcome.Accepted || outcome.Confirmed {
		t.Fatalf("expired confirmation produced the wrong outcome: %#v", outcome)
	}
	if transport.killCalls != 1 {
		t.Fatalf("client-kill was sent %d times", transport.killCalls)
	}
}

type partialWriteConn struct{}

func (partialWriteConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (partialWriteConn) Write([]byte) (int, error)        { return 5, errors.New("partial write") }
func (partialWriteConn) Close() error                     { return nil }
func (partialWriteConn) LocalAddr() net.Addr              { return nil }
func (partialWriteConn) RemoteAddr() net.Addr             { return nil }
func (partialWriteConn) SetDeadline(time.Time) error      { return nil }
func (partialWriteConn) SetReadDeadline(time.Time) error  { return nil }
func (partialWriteConn) SetWriteDeadline(time.Time) error { return nil }

func TestClientKillPartialWriteIsNotFullSend(t *testing.T) {
	session := &managementSession{
		connection: partialWriteConn{},
		reader:     bufio.NewReader(partialWriteConn{}),
		clock:      systemManagementClock{},
	}
	result, err := session.clientKill("0", time.Now().Add(time.Second))
	if err == nil {
		t.Fatal("partial write was accepted")
	}
	if result.Sent || !result.Partial || result.BytesWritten != 5 {
		t.Fatalf("partial write was not classified truthfully: %#v", result)
	}
}

type fullWriteErrorConn struct {
	partialWriteConn
}

func (fullWriteErrorConn) Write(payload []byte) (int, error) {
	return len(payload), errors.New("full write error")
}

func TestClientKillFullWriteWithErrorIsNotSent(t *testing.T) {
	command, err := managementClientKillCommand("0")
	if err != nil {
		t.Fatal(err)
	}
	session := &managementSession{
		connection: fullWriteErrorConn{},
		reader:     bufio.NewReader(fullWriteErrorConn{}),
		clock:      systemManagementClock{},
	}
	result, err := session.clientKill("0", time.Now().Add(time.Second))
	if err == nil {
		t.Fatal("full write with error was accepted")
	}
	if result.Sent || result.Partial || result.BytesWritten != len(command) {
		t.Fatalf("full write with error was not classified truthfully: %#v", result)
	}
}

func TestDisconnectPartialWriteIsIndeterminate(t *testing.T) {
	target, control := fakePeers()
	clock := newFakeManagementClock()
	t0 := clock.Now()
	transport := &fakeManagementTransport{
		clock: clock,
		statuses: []fakeStatusStep{
			{peers: []managementPeer{target, control}},
			{peers: []managementPeer{target, control}},
		},
		kill:    managementCommandResult{BytesWritten: 5, Partial: true},
		killErr: errors.New("partial write"),
	}
	outcome, err := disconnectWithTransport(transport, managementConnectTiming{}, "nexo:"+testDevice, t0, clock, func(time.Duration) {}, managementBudget{
		accept: 100 * time.Millisecond,
		total:  300 * time.Millisecond,
		poll:   time.Millisecond,
	})
	if !errors.Is(err, ErrDisconnectUnconfirmed) || errors.Is(err, ErrDisconnectNotAttempted) {
		t.Fatalf("partial write was misclassified: %v", err)
	}
	if !outcome.Attempted || !outcome.Partial || outcome.Sent || outcome.Accepted || outcome.Confirmed {
		t.Fatalf("partial write produced the wrong outcome: %#v", outcome)
	}
	if transport.killCalls != 1 {
		t.Fatalf("client-kill was attempted %d times", transport.killCalls)
	}
}

func TestRevocationPartialWriteIsNotNotAttempted(t *testing.T) {
	root, issued := managementFixture(t)
	result, err := revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(string, string, string, time.Time, managementClock) (disconnectOutcome, error) {
		return disconnectOutcome{Attempted: true, Partial: true}, ErrDisconnectUnconfirmed
	})
	if !errors.Is(err, ErrDisconnectUnconfirmed) || errors.Is(err, ErrDisconnectNotAttempted) {
		t.Fatalf("partial write was misclassified: %v", err)
	}
	if !result.ManagementCommandAttempted || !result.ManagementWritePartial || result.ManagementCommandSent || result.DisconnectConfirmed {
		t.Fatalf("partial write was reported incorrectly: %#v", result)
	}
}

func TestRevocationSLAExceededReturnedAfterConfirmation(t *testing.T) {
	for _, outcome := range []disconnectOutcome{
		{Sent: true, Attempted: true, Accepted: true, Confirmed: true, AcceptWithinBudget: false, DisconnectWithinBudget: true},
		{Sent: true, Attempted: true, Accepted: true, Confirmed: true, AcceptWithinBudget: true, DisconnectWithinBudget: false},
	} {
		root, issued := managementFixture(t)
		result, err := revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(string, string, string, time.Time, managementClock) (disconnectOutcome, error) {
			return outcome, nil
		})
		if !errors.Is(err, ErrRevocationSLAExceeded) {
			t.Fatalf("SLA miss was not returned by the runtime: %v", err)
		}
		if !result.Revoked || !result.DisconnectConfirmed {
			t.Fatalf("SLA error hid the confirmed revocation: %#v", result)
		}
	}
}

func confirmedDisconnect(string, string, string, time.Time, managementClock) (disconnectOutcome, error) {
	return disconnectOutcome{Sent: true, Accepted: true, Confirmed: true, AcceptWithinBudget: true, DisconnectWithinBudget: true}, nil
}

func TestRevocationPublishesCRLBeforeDisconnectAndPreservesItOnFailure(t *testing.T) {
	root, issued := managementFixture(t)
	var (
		called  bool
		gotEnv  string
		gotDev  string
		crlSeen bool
	)
	result, err := revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(_, environmentID, deviceID string, _ time.Time, _ managementClock) (disconnectOutcome, error) {
		called = true
		gotEnv, gotDev = environmentID, deviceID
		crlSeen = crlContainsSerial(t, filepath.Join(root, testEnvironment, "pki"), issued.Serial)
		return disconnectOutcome{
			Sent: true, Accepted: true, Confirmed: true,
			AcceptWithinBudget: true, DisconnectWithinBudget: true,
			Timings: RevocationTimings{AcceptElapsedNS: 10, DisconnectElapsedNS: 20},
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called || gotEnv != testEnvironment || gotDev != testDevice {
		t.Fatalf("disconnect called with wrong identity: called=%v env=%q device=%q", called, gotEnv, gotDev)
	}
	if !crlSeen {
		t.Fatal("disconnect was requested before the CRL entry was visible")
	}
	if !result.Revoked || !result.DisconnectRequested || !result.ManagementCommandSent || !result.ManagementAccepted || !result.DisconnectConfirmed {
		t.Fatalf("unexpected result %#v", result)
	}
	if !result.AcceptWithinBudget || !result.DisconnectWithinBudget {
		t.Fatalf("SLA flags were not preserved: %#v", result)
	}
	if result.Timings.AcceptElapsedNS != 10 || result.Timings.DisconnectElapsedNS != 20 {
		t.Fatalf("disconnect timings were not preserved: %#v", result.Timings)
	}
	if result.Timings.CRLPublishedNS < 0 {
		t.Fatalf("CRL timing was not measured: %#v", result.Timings)
	}

	root, issued = managementFixture(t)
	result, err = revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(string, string, string, time.Time, managementClock) (disconnectOutcome, error) {
		return disconnectOutcome{}, errors.New("injected management failure")
	})
	if !errors.Is(err, ErrDisconnectNotAttempted) {
		t.Fatalf("partial failure was not marked as not attempted: %v", err)
	}
	if !result.Revoked || result.DisconnectRequested || result.ManagementCommandSent || result.ManagementAccepted || result.DisconnectConfirmed {
		t.Fatalf("management failure reported a confirmed disconnect: %#v", result)
	}
	if !crlContainsSerial(t, filepath.Join(root, testEnvironment, "pki"), issued.Serial) {
		t.Fatal("CRL entry was rolled back after management failure")
	}
	if !clientRecordRevoked(t, root, testRequest) {
		t.Fatal("client record was not kept revoked after management failure")
	}
}

func TestRevocationAcceptedButUnconfirmedIsNotSuccess(t *testing.T) {
	root, issued := managementFixture(t)
	result, err := revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(string, string, string, time.Time, managementClock) (disconnectOutcome, error) {
		return disconnectOutcome{Sent: true, Accepted: true, Timings: RevocationTimings{AcceptElapsedNS: 5}}, ErrDisconnectUnconfirmed
	})
	if !errors.Is(err, ErrDisconnectUnconfirmed) {
		t.Fatalf("unconfirmed disconnect was not surfaced: %v", err)
	}
	if !result.Revoked || !result.DisconnectRequested || !result.ManagementCommandSent || !result.ManagementAccepted || result.DisconnectConfirmed {
		t.Fatalf("accepted command was reported as confirmed: %#v", result)
	}
}

func TestRevocationRejectedDisconnectIsNotSuccess(t *testing.T) {
	root, issued := managementFixture(t)
	result, err := revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(string, string, string, time.Time, managementClock) (disconnectOutcome, error) {
		return disconnectOutcome{Sent: true}, ErrDisconnectRejected
	})
	if !errors.Is(err, ErrDisconnectRejected) {
		t.Fatalf("rejected disconnect was not surfaced: %v", err)
	}
	if !result.Revoked || result.DisconnectRequested || !result.ManagementCommandSent || result.ManagementAccepted || result.DisconnectConfirmed {
		t.Fatalf("rejected command was reported as accepted: %#v", result)
	}
}

func TestRevocationRetryStillAttemptsPendingDisconnect(t *testing.T) {
	root, issued := managementFixture(t)
	if _, err := revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, confirmedDisconnect); err != nil {
		t.Fatal(err)
	}
	attempts := 0
	result, err := revokeClientCertificateWith(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(_, environmentID, deviceID string, _ time.Time, _ managementClock) (disconnectOutcome, error) {
		attempts++
		if environmentID != testEnvironment || deviceID != testDevice {
			t.Fatalf("retry used wrong identity: env=%q device=%q", environmentID, deviceID)
		}
		return disconnectOutcome{Sent: true, Accepted: true, Confirmed: true, AcceptWithinBudget: true, DisconnectWithinBudget: true}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || !result.Revoked || !result.DisconnectRequested || !result.DisconnectConfirmed {
		t.Fatalf("already persisted revocation skipped disconnect: attempts=%d result=%#v", attempts, result)
	}
}

func TestRevocationIdentityMismatchNeverDisconnects(t *testing.T) {
	root, issued := managementFixture(t)
	attempted := false
	_, err := revokeClientCertificateWith(root, testRequest, testEnvironment, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", testDevice, issued.Serial, func(string, string, string, time.Time, managementClock) (disconnectOutcome, error) {
		attempted = true
		return disconnectOutcome{Sent: true, Accepted: true, Confirmed: true}, nil
	})
	if err == nil || attempted {
		t.Fatalf("mismatched tenant reached the management channel: err=%v attempted=%v", err, attempted)
	}
}

func TestRevocationInstrumentationUsesT0AndFakeClock(t *testing.T) {
	root, issued := managementFixture(t)
	base := time.Now()
	clock := &scriptedManagementClock{times: []time.Time{
		base,
		base.Add(1 * time.Millisecond),
		base.Add(2 * time.Millisecond),
		base.Add(3 * time.Millisecond),
		base.Add(4 * time.Millisecond),
		base.Add(5 * time.Millisecond),
	}}
	var gotT0 time.Time
	result, err := revokeClientCertificateWithClock(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial, func(_, _, _ string, t0 time.Time, injected managementClock) (disconnectOutcome, error) {
		gotT0 = t0
		if injected != clock {
			t.Fatal("disconnect did not receive the revocation clock")
		}
		return disconnectOutcome{
			Sent: true, Accepted: true, Confirmed: true,
			AcceptWithinBudget: true, DisconnectWithinBudget: true,
			Timings: RevocationTimings{AcceptElapsedNS: 12, DisconnectElapsedNS: 34},
		}, nil
	}, clock)
	if err != nil {
		t.Fatal(err)
	}
	if !gotT0.Equal(base) {
		t.Fatalf("disconnect did not receive the T0 captured at flow entry: %v", gotT0)
	}
	if result.Timings.AcceptElapsedNS != 12 || result.Timings.DisconnectElapsedNS != 34 {
		t.Fatalf("instrumentation was not preserved: %#v", result.Timings)
	}
	if result.Timings.ValidationEndNS != int64(time.Millisecond) {
		t.Fatalf("validation timing was not measured from T0: %#v", result.Timings)
	}
	if result.Timings.RecordReadEndNS != int64(2*time.Millisecond) {
		t.Fatalf("record read timing was not measured from T0: %#v", result.Timings)
	}
	if result.Timings.CRLStartNS != int64(3*time.Millisecond) {
		t.Fatalf("CRL start timing was not measured from T0: %#v", result.Timings)
	}
	if result.Timings.CRLPublishedNS != int64(4*time.Millisecond) {
		t.Fatalf("CRL publication timing was not measured from T0: %#v", result.Timings)
	}
	if result.Timings.RecordUpdatedNS != int64(5*time.Millisecond) {
		t.Fatalf("record update timing was not measured from T0: %#v", result.Timings)
	}
}

func managementClientListHeader() string {
	return "HEADER\tCLIENT_LIST\tCommon Name\tReal Address\tVirtual Address\tVirtual IPv6 Address\tBytes Received\tBytes Sent\tConnected Since\tConnected Since (time_t)\tUsername\tClient ID\tPeer ID\tData Channel Cipher\r\n"
}

func managementPeerRow(commonName, realAddress, clientID, peerID string) string {
	return strings.Join([]string{
		"CLIENT_LIST",
		commonName,
		realAddress,
		"10.8.0.2",
		"",
		"1",
		"1",
		"2026-11-11 00:00:00",
		"1",
		"UNDEF",
		clientID,
		peerID,
		"AES-256-GCM",
	}, "\t")
}

func managementStatusFrame(rows ...string) string {
	var builder strings.Builder
	builder.WriteString("TITLE\tOpenVPN 2.6.14\r\n")
	builder.WriteString(managementClientListHeader())
	for _, row := range rows {
		builder.WriteString(row)
		builder.WriteString("\r\n")
	}
	builder.WriteString("HEADER\tROUTING_TABLE\tVirtual Address\tCommon Name\tReal Address\tLast Ref\tLast Ref (time_t)\r\n")
	builder.WriteString("GLOBAL_STATS\tMax bcast/mcast queue length\t0\r\n")
	builder.WriteString("END\r\n")
	return builder.String()
}

func managementFixture(t *testing.T) (string, ClientCertificate) {
	t.Helper()
	root := t.TempDir()
	pki := filepath.Join(root, testEnvironment, "pki")
	if err := os.MkdirAll(pki, 0711); err != nil {
		t.Fatal(err)
	}
	if err := ensurePKI(pki, DesiredEnvironment{ID: testEnvironment}); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "untrusted-subject"}}, key)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := issueClientCertificate(root, testRequest, testEnvironment, testTenant, testDevice, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})))
	if err != nil {
		t.Fatal(err)
	}
	return root, issued
}

func crlContainsSerial(t *testing.T, pki, serialHex string) bool {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(pki, "crl.pem"))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	list, err := x509.ParseRevocationList(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	serial, _ := new(big.Int).SetString(serialHex, 16)
	for _, entry := range list.RevokedCertificateEntries {
		if entry.SerialNumber.Cmp(serial) == 0 {
			return true
		}
	}
	return false
}

func clientRecordRevoked(t *testing.T, root, requestID string) bool {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, testEnvironment, "pki", "clients", requestID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var record issuedClientRecord
	if err = json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	return record.Revoked
}
