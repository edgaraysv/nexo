package vpnruntime

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"
)

type DesiredEnvironment struct {
	ID             string                  `json:"id"`
	Engine         string                  `json:"engine"`
	Protocol       string                  `json:"protocol"`
	ListenerPort   int                     `json:"listenerPort"`
	TunnelIPv4CIDR string                  `json:"tunnelIpv4Cidr"`
	IPv6Enabled    bool                    `json:"ipv6Enabled"`
	NamespaceName  string                  `json:"namespaceName"`
	DesiredState   string                  `json:"desiredState"`
	Revision       int64                   `json:"revision"`
	PrivateAccess  []PrivateAccessRule     `json:"privateAccess,omitempty"`
	WireGuard      *WireGuardConfiguration `json:"wireguard,omitempty"`
}

type WireGuardConfiguration struct {
	MTU   int             `json:"mtu"`
	Peers []WireGuardPeer `json:"peers"`
}

type WireGuardPeer struct {
	DeviceID                   string   `json:"deviceId"`
	PublicKey                  string   `json:"publicKey"`
	AllowedIPs                 []string `json:"allowedIps"`
	PersistentKeepaliveSeconds int      `json:"persistentKeepaliveSeconds"`
}

// PrivateAccessRule is an exact destination tuple authorized by F08. No
// subnet, URL, shell fragment, or OpenVPN directive crosses the API boundary.
type PrivateAccessRule struct {
	Address   string `json:"address"`
	Protocol  string `json:"protocol"`
	PortStart int    `json:"portStart"`
	PortEnd   int    `json:"portEnd"`
}

type Result struct {
	ID                       string `json:"-"`
	Revision                 int64  `json:"revision"`
	ObservedState            string `json:"observed_state"`
	ConfigDigest             string `json:"config_digest,omitempty"`
	ErrorCode                string `json:"error_code,omitempty"`
	WireGuardServerPublicKey string `json:"wireguard_server_public_key,omitempty"`
}

type Link struct {
	HostInterface      string
	NamespaceInterface string
	HostAddress        string
	NamespaceAddress   string
	Prefix             string
}

type Host interface {
	// Inspect reports the current digest and whether the environment is
	// already applied and healthy without mutating native state. An error
	// means the inspection itself was inconclusive and must never be
	// interpreted as healthy.
	Inspect(DesiredEnvironment, Link) (string, bool, error)
	Ensure(DesiredEnvironment, Link) (string, error)
	Suspend(DesiredEnvironment) (string, error)
	Retire(DesiredEnvironment) (string, error)
	CleanupUnknown(map[string]struct{}) error
}

// Progress publishes an observed transition before a real repair is applied.
// A failure means the transition could not be made verifiable.
type Progress func(Result) error

type Reconciler struct{ host Host }

var (
	uuidPattern      = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
	namespacePattern = regexp.MustCompile(`^nexo-[a-f0-9]{12}$`)
)

func New(host Host) *Reconciler         { return &Reconciler{host: host} }
func ValidEnvironmentID(id string) bool { return uuidPattern.MatchString(id) }

// Reconcile reconciles every environment, continuing with the remaining ones
// when an individual environment fails. A non-nil progress callback receives a
// provisioning transition only when native work is actually required.
func (r *Reconciler) Reconcile(desired []DesiredEnvironment, progress Progress) []Result {
	items := append([]DesiredEnvironment(nil), desired...)
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	known := make(map[string]struct{}, len(items))
	links := make(map[string]string, len(items))
	ports := make(map[int]string, len(items))
	accessEnvironments := make([]DesiredEnvironment, 0)
	invalid := make(map[string]string)
	for _, environment := range items {
		if _, duplicate := known[environment.ID]; duplicate {
			invalid[environment.ID] = "invalid_spec"
		}
		known[environment.ID] = struct{}{}
		if err := validate(environment); err != nil {
			invalid[environment.ID] = "invalid_spec"
			continue
		}
		if environment.Engine == "wireguard" && len(environment.PrivateAccess) > 0 {
			invalid[environment.ID] = "wireguard_private_access_unsupported"
			continue
		}
		if environment.DesiredState != "active" {
			continue
		}
		if len(environment.PrivateAccess) > 0 {
			for _, previous := range accessEnvironments {
				if tunnelPrefixesOverlap(environment.TunnelIPv4CIDR, previous.TunnelIPv4CIDR) {
					invalid[previous.ID], invalid[environment.ID] = "transit_collision", "transit_collision"
				}
			}
			accessEnvironments = append(accessEnvironments, environment)
		}
		link := linkFor(environment.ID)
		if previous, exists := links[link.Prefix]; exists && previous != environment.ID {
			invalid[previous], invalid[environment.ID] = "transit_collision", "transit_collision"
		} else {
			links[link.Prefix] = environment.ID
		}
		if previous, exists := ports[environment.ListenerPort]; exists && previous != environment.ID {
			invalid[previous], invalid[environment.ID] = "port_collision", "port_collision"
		} else {
			ports[environment.ListenerPort] = environment.ID
		}
	}
	if err := r.host.CleanupUnknown(known); err != nil {
		for _, environment := range items {
			if _, exists := invalid[environment.ID]; !exists {
				invalid[environment.ID] = "runtime_cleanup_failed"
			}
		}
	}
	results := make([]Result, 0, len(items))
	for _, environment := range items {
		if code := invalid[environment.ID]; code != "" {
			results = append(results, Result{ID: environment.ID, Revision: environment.Revision, ObservedState: "error", ErrorCode: code})
			continue
		}
		var digest string
		var err error
		switch environment.DesiredState {
		case "active":
			current, clean, inspectErr := r.host.Inspect(environment, linkFor(environment.ID))
			if inspectErr != nil {
				results = append(results, Result{ID: environment.ID, Revision: environment.Revision, ObservedState: "error", ErrorCode: "runtime_inspect_failed"})
				continue
			}
			if clean {
				digest = current
				break
			}
			if progress != nil {
				if reportErr := progress(Result{ID: environment.ID, Revision: environment.Revision, ObservedState: "provisioning"}); reportErr != nil {
					results = append(results, Result{ID: environment.ID, Revision: environment.Revision, ObservedState: "error", ErrorCode: "runtime_report_failed"})
					continue
				}
			}
			digest, err = r.host.Ensure(environment, linkFor(environment.ID))
		case "suspended":
			digest, err = r.host.Suspend(environment)
		case "retired":
			digest, err = r.host.Retire(environment)
		}
		if err != nil {
			code := "runtime_apply_failed"
			if errors.Is(err, ErrForwardingDisabled) {
				code = "forwarding_disabled"
			} else if errors.Is(err, ErrRouteConflict) {
				code = "route_conflict"
			} else if errors.Is(err, ErrWireGuardPrivateAccessUnsupported) {
				code = "wireguard_private_access_unsupported"
			}
			results = append(results, Result{ID: environment.ID, Revision: environment.Revision, ObservedState: "error", ErrorCode: code})
			continue
		}
		result := Result{ID: environment.ID, Revision: environment.Revision, ObservedState: environment.DesiredState, ConfigDigest: digest}
		if environment.Engine == "wireguard" && environment.DesiredState == "active" {
			if reporter, ok := r.host.(interface {
				WireGuardServerPublicKey(DesiredEnvironment) (string, error)
			}); ok {
				publicKey, keyErr := reporter.WireGuardServerPublicKey(environment)
				if keyErr != nil {
					results = append(results, Result{ID: environment.ID, Revision: environment.Revision, ObservedState: "error", ErrorCode: "wireguard_key_unavailable"})
					continue
				}
				result.WireGuardServerPublicKey = publicKey
			} else {
				results = append(results, Result{ID: environment.ID, Revision: environment.Revision, ObservedState: "error", ErrorCode: "wireguard_key_unavailable"})
				continue
			}
		}
		results = append(results, result)
	}
	return results
}

func tunnelPrefixesOverlap(left, right string) bool {
	a, errA := netip.ParsePrefix(left)
	b, errB := netip.ParsePrefix(right)
	return errA == nil && errB == nil && (a.Contains(b.Addr()) || b.Contains(a.Addr()))
}

var ErrForwardingDisabled = errors.New("ipv4 forwarding disabled")
var ErrRouteConflict = errors.New("private route already exists and is not owned by this runtime")
var ErrResourceNotFound = errors.New("managed network resource not found")
var ErrWireGuardPrivateAccessUnsupported = errors.New("wireguard private access unsupported")

func validate(environment DesiredEnvironment) error {
	if !uuidPattern.MatchString(environment.ID) || !namespacePattern.MatchString(environment.NamespaceName) || environment.NamespaceName != "nexo-"+strings.ReplaceAll(environment.ID, "-", "")[:12] {
		return errors.New("invalid identity")
	}
	if environment.Engine != "openvpn" && environment.Engine != "wireguard" || environment.Protocol != "udp" || environment.IPv6Enabled || environment.ListenerPort < 1024 || environment.ListenerPort > 65535 || environment.Revision < 1 {
		return errors.New("invalid settings")
	}
	if environment.Engine == "openvpn" && environment.WireGuard != nil || environment.Engine == "wireguard" && (environment.WireGuard == nil || environment.WireGuard.MTU != 1420 || len(environment.WireGuard.Peers) > 4096) {
		return errors.New("invalid wireguard settings")
	}
	if environment.DesiredState != "active" && environment.DesiredState != "suspended" && environment.DesiredState != "retired" {
		return errors.New("invalid desired state")
	}
	prefix, err := netip.ParsePrefix(environment.TunnelIPv4CIDR)
	if err != nil || !prefix.Addr().Is4() || prefix.Bits() < 16 || prefix.Bits() > 30 || prefix != prefix.Masked() || !privateIPv4(prefix.Addr()) {
		return errors.New("invalid tunnel cidr")
	}
	if len(environment.PrivateAccess) > 64 {
		return errors.New("too many private access rules")
	}
	seen := map[PrivateAccessRule]struct{}{}
	byService := map[string][]PrivateAccessRule{}
	for _, rule := range environment.PrivateAccess {
		address, parseErr := netip.ParseAddr(rule.Address)
		if parseErr != nil || !address.Is4() || !privateIPv4(address) || rule.Protocol != "tcp" && rule.Protocol != "udp" || rule.PortStart < 1 || rule.PortEnd < rule.PortStart || rule.PortEnd > 65535 {
			return errors.New("invalid private access rule")
		}
		if _, duplicate := seen[rule]; duplicate {
			return errors.New("duplicate private access rule")
		}
		seen[rule] = struct{}{}
		key := rule.Address + "|" + rule.Protocol
		byService[key] = append(byService[key], rule)
	}
	if environment.Engine == "wireguard" {
		seenKeys, seenAddresses := map[string]struct{}{}, map[string]struct{}{}
		for _, peer := range environment.WireGuard.Peers {
			if !uuidPattern.MatchString(peer.DeviceID) || !validWireGuardKey(peer.PublicKey) || len(peer.AllowedIPs) != 1 || peer.PersistentKeepaliveSeconds != 0 && peer.PersistentKeepaliveSeconds != 25 {
				return errors.New("invalid wireguard peer")
			}
			if _, duplicate := seenKeys[peer.PublicKey]; duplicate {
				return errors.New("duplicate wireguard key")
			}
			seenKeys[peer.PublicKey] = struct{}{}
			peerPrefix, parseErr := netip.ParsePrefix(peer.AllowedIPs[0])
			if parseErr != nil || !peerPrefix.Addr().Is4() || peerPrefix.Bits() != 32 || !prefix.Contains(peerPrefix.Addr()) {
				return errors.New("invalid wireguard allowed ips")
			}
			address := peerPrefix.Addr().String()
			serverAddress, addressErr := wireGuardServerAddress(environment.TunnelIPv4CIDR)
			if addressErr != nil {
				return errors.New("invalid wireguard server address")
			}
			serverPrefix, parseServerErr := netip.ParsePrefix(serverAddress)
			if parseServerErr != nil {
				return errors.New("invalid wireguard server address")
			}
			serverIP := serverPrefix.Addr()
			pool := prefix.Masked().Addr().As4()
			first := binary.BigEndian.Uint32(pool[:])
			last := first + (uint32(1) << uint(32-prefix.Bits())) - 1
			peerIP := peerPrefix.Addr().As4()
			peerAddress := binary.BigEndian.Uint32(peerIP[:])
			serverBytes := serverIP.As4()
			serverValue := binary.BigEndian.Uint32(serverBytes[:])
			if peerAddress <= serverValue || peerAddress >= last {
				return errors.New("wireguard peer address is reserved")
			}
			if _, duplicate := seenAddresses[address]; duplicate {
				return errors.New("duplicate wireguard address")
			}
			seenAddresses[address] = struct{}{}
		}
	}
	for _, rules := range byService {
		sort.Slice(rules, func(i, j int) bool {
			if rules[i].PortStart != rules[j].PortStart {
				return rules[i].PortStart < rules[j].PortStart
			}
			return rules[i].PortEnd < rules[j].PortEnd
		})
		for i := 1; i < len(rules); i++ {
			if rules[i].PortStart <= rules[i-1].PortEnd {
				return errors.New("overlapping private access rules")
			}
		}
	}
	return nil
}

func validWireGuardKey(value string) bool {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != value {
		return false
	}
	for _, b := range decoded {
		if b != 0 {
			return true
		}
	}
	return false
}

func wireGuardServerAddress(cidr string) (string, error) {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil || !prefix.Addr().Is4() {
		return "", errors.New("invalid wireguard tunnel prefix")
	}
	base := prefix.Masked().Addr().As4()
	for index := len(base) - 1; index >= 0; index-- {
		base[index]++
		if base[index] != 0 {
			break
		}
	}
	return fmt.Sprintf("%s/%d", netip.AddrFrom4(base), prefix.Bits()), nil
}

func privateIPv4(address netip.Addr) bool {
	return netip.MustParsePrefix("10.0.0.0/8").Contains(address) || netip.MustParsePrefix("172.16.0.0/12").Contains(address) || netip.MustParsePrefix("192.168.0.0/16").Contains(address)
}

func linkFor(id string) Link {
	sum := sha256.Sum256([]byte(id))
	index := (uint16(sum[0])<<8 | uint16(sum[1])) & 0x3fff
	third, fourth := byte(index>>6), byte((index&0x3f)<<2)
	prefix := fmt.Sprintf("100.127.%d.%d/30", third, fourth)
	short := hex.EncodeToString(sum[:5])
	return Link{
		HostInterface: "nxh" + short, NamespaceInterface: "nxn" + short,
		HostAddress: fmt.Sprintf("100.127.%d.%d", third, fourth+1), NamespaceAddress: fmt.Sprintf("100.127.%d.%d", third, fourth+2), Prefix: prefix,
	}
}
