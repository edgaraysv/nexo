//go:build linux

package vpnruntime

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	nativeRoot     = "/var/lib/nexo-node/environments"
	transientUnits = "/run/systemd/system"

	// OpenVPN runs as "nobody" and must be able to traverse both directories to
	// read the CRL. 0711 grants search/traverse without allowing directory
	// listing; file modes stay 0600 for private keys and 0644 for public
	// material. WireGuard keeps its existing 0700 environment mode.
	openVPNEnvironmentDirectoryMode = os.FileMode(0711)
	openVPNPKIDirectoryMode         = os.FileMode(0711)
	managementSocketName            = "mgmt.sock"
)

type commandRunner interface {
	Run([]byte, string, ...string) (string, error)
}
type execRunner struct{}

func (execRunner) Run(input []byte, name string, arguments ...string) (string, error) {
	allowed := map[string]bool{"ip": true, "nft": true, "systemctl": true, "sysctl": true, "wg": true}
	if !allowed[name] {
		return "", errors.New("command not allowlisted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, name, arguments...)
	if input != nil {
		command.Stdin = bytes.NewReader(input)
	}
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		return "", errors.New("command timeout")
	}
	if err != nil {
		lower := strings.ToLower(string(output))
		if strings.Contains(lower, "does not exist") || strings.Contains(lower, "no such device") || strings.Contains(lower, "no such file or directory") || strings.Contains(lower, "no such process") {
			return "", ErrResourceNotFound
		}
		return "", fmt.Errorf("%s failed", name)
	}
	return string(output), nil
}

type NativeHost struct {
	root, units, forwardingPath string
	runner                      commandRunner

	// Management sockets are created by the root OpenVPN unit. Tests override
	// these to the unprivileged test identity; production keeps the zero value
	// (root:root).
	managementUID, managementGID uint32
}
type diskManifest struct {
	Environment DesiredEnvironment `json:"environment"`
	Digest      string             `json:"digest"`
}
type runtimeBundle struct {
	openvpn, wireguard, namespaceFirewall, hostFirewall, unit, digest string
	ccd                                                               map[string]string
}

func NewNativeHost() *NativeHost {
	return &NativeHost{root: nativeRoot, units: transientUnits, forwardingPath: "/proc/sys/net/ipv4/ip_forward", runner: execRunner{}}
}

func (host *NativeHost) Ensure(environment DesiredEnvironment, link Link) (digest string, returned error) {
	if environment.Engine == "openvpn" {
		forwarding, err := os.ReadFile(host.forwardingPath)
		if err != nil || strings.TrimSpace(string(forwarding)) != "1" {
			return "", ErrForwardingDisabled
		}
	} else if len(environment.PrivateAccess) > 0 {
		return "", ErrWireGuardPrivateAccessUnsupported
	}
	directory := filepath.Join(host.root, environment.ID)
	directoryMode := environmentDirectoryMode(environment)
	if err := os.MkdirAll(directory, directoryMode); err != nil {
		return "", err
	}
	if err := os.Chmod(directory, directoryMode); err != nil {
		return "", err
	}
	if environment.Engine == "wireguard" {
		if _, err := ensureWireGuardServerKey(filepath.Join(directory, "wireguard", "server.key")); err != nil {
			return "", err
		}
	}
	bundle, err := host.render(environment, link)
	if err != nil {
		return "", err
	}
	if host.healthy(environment, bundle) {
		return bundle.digest, nil
	}
	// A filesystem-mode-only drift must not tear down a healthy runtime:
	// repair the PKI directory and the management socket in place and return
	// before cleanup/restart. The environment directory is already re-chmodded
	// above. If the in-place repair fails or something else is also unhealthy,
	// fall through to the full rebuild below.
	if host.runtimeHealthy(environment, bundle) {
		pkiErr := host.ensurePKIDirectoryMode(environment)
		socketErr := host.hardenManagementSocket(environment)
		if pkiErr == nil && socketErr == nil && host.healthy(environment, bundle) {
			return bundle.digest, nil
		}
	}
	if err = host.checkRouteAvailable(environment, link); err != nil {
		return "", err
	}
	if err = host.cleanupRuntime(environment); err != nil {
		return "", err
	}
	defer func() {
		if returned != nil {
			_ = host.cleanupRuntime(environment)
		}
	}()
	if environment.Engine == "openvpn" {
		pkiDirectory := filepath.Join(directory, "pki")
		if err = os.MkdirAll(pkiDirectory, 0700); err != nil {
			return "", err
		}
		if err = os.Chmod(pkiDirectory, openVPNPKIDirectoryMode); err != nil {
			return "", err
		}
		if err = ensurePKI(pkiDirectory, environment); err != nil {
			return "", err
		}
		// ensurePKI is idempotent and only writes files, but re-assert the
		// directory mode so a pre-existing directory cannot retain 0700.
		if err = os.Chmod(pkiDirectory, openVPNPKIDirectoryMode); err != nil {
			return "", err
		}
	}
	for name, value := range bundleFiles(environment, bundle) {
		if err = atomicWrite(directory, name, []byte(value), 0600); err != nil {
			return "", err
		}
	}
	if err = syncCCD(directory, bundle.ccd); err != nil {
		return "", err
	}
	if err = atomicJSON(directory, "manifest.json", diskManifest{Environment: environment, Digest: bundle.digest}); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "netns", "add", environment.NamespaceName); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "link", "add", link.HostInterface, "type", "veth", "peer", "name", link.NamespaceInterface); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "link", "set", link.NamespaceInterface, "netns", environment.NamespaceName); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "addr", "add", link.HostAddress+"/30", "dev", link.HostInterface); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "link", "set", link.HostInterface, "up"); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "-n", environment.NamespaceName, "addr", "add", link.NamespaceAddress+"/30", "dev", link.NamespaceInterface); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "-n", environment.NamespaceName, "link", "set", "lo", "up"); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "-n", environment.NamespaceName, "link", "set", link.NamespaceInterface, "up"); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "-n", environment.NamespaceName, "route", "replace", "default", "via", link.HostAddress, "dev", link.NamespaceInterface); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "sysctl", "-q", "-w", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1"); err != nil {
		return "", err
	}
	if _, err = host.runner.Run([]byte(bundle.namespaceFirewall), "ip", "netns", "exec", environment.NamespaceName, "nft", "-f", "-"); err != nil {
		return "", err
	}
	if _, err = host.runner.Run([]byte(bundle.hostFirewall), "nft", "-f", "-"); err != nil {
		return "", err
	}
	if requiresHostTransit(environment) {
		if _, err = host.runner.Run(nil, "ip", "route", "add", environment.TunnelIPv4CIDR, "via", link.NamespaceAddress, "dev", link.HostInterface); err != nil {
			return "", err
		}
	}
	unitPath := filepath.Join(host.units, unitName(environment))
	if err = atomicWrite(host.units, filepath.Base(unitPath), []byte(bundle.unit), 0644); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "systemctl", "daemon-reload"); err != nil {
		return "", err
	}
	if _, err = host.runner.Run(nil, "systemctl", "start", unitName(environment)); err != nil {
		return "", err
	}
	for attempt := 0; attempt < 20; attempt++ {
		// OpenVPN publishes the management socket after the unit starts. Harden
		// and verify it before reporting the environment ready. This removes the
		// persistent 0777 state, but it cannot make OpenVPN's bind atomic; the
		// rendered management-client-user root gate remains the peer-UID
		// control from bind. The 100 ms loop bounds, but does not eliminate,
		// the post-creation chmod window.
		if err = host.hardenManagementSocket(environment); err == nil && host.healthy(environment, bundle) {
			return bundle.digest, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return "", errors.New("runtime did not become healthy")
}

// Inspect reuses the renderer and health probe of Ensure without mutating any
// native state, so the reconciler can decide whether a repair is really needed.
func (host *NativeHost) Inspect(environment DesiredEnvironment, link Link) (string, bool, error) {
	if environment.Engine == "wireguard" {
		if _, err := os.Lstat(filepath.Join(host.root, environment.ID, "wireguard", "server.key")); errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		} else if err != nil {
			return "", false, err
		}
	}
	bundle, err := host.render(environment, link)
	if err != nil {
		return "", false, err
	}
	if !host.healthy(environment, bundle) {
		return "", false, nil
	}
	return bundle.digest, true, nil
}

// WireGuardServerPublicKey reads only the public half of the server identity.
// The private half is never returned by this interface or placed in a report.
func (host *NativeHost) WireGuardServerPublicKey(environment DesiredEnvironment) (string, error) {
	return readWireGuardServerKey(filepath.Join(host.root, environment.ID, "wireguard", "server.key"))
}

func (host *NativeHost) Suspend(environment DesiredEnvironment) (string, error) {
	return host.inactive(environment)
}
func (host *NativeHost) Retire(environment DesiredEnvironment) (string, error) {
	return host.inactive(environment)
}
func (host *NativeHost) inactive(environment DesiredEnvironment) (string, error) {
	bundle, err := host.render(environment, linkFor(environment.ID))
	if err != nil {
		return "", err
	}
	if err = host.cleanupRuntime(environment); err != nil {
		return "", err
	}
	directory := filepath.Join(host.root, environment.ID)
	if err = os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	if err = atomicJSON(directory, "manifest.json", diskManifest{Environment: environment, Digest: bundle.digest}); err != nil {
		return "", err
	}
	return bundle.digest, nil
}

func (host *NativeHost) CleanupUnknown(known map[string]struct{}) error {
	entries, err := os.ReadDir(host.root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var cleanupErrors []error
	for _, entry := range entries {
		if !entry.IsDir() || !uuidPattern.MatchString(entry.Name()) {
			continue
		}
		if _, exists := known[entry.Name()]; exists {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(host.root, entry.Name(), "manifest.json"))
		if readErr != nil {
			continue
		}
		var manifest diskManifest
		if json.Unmarshal(raw, &manifest) != nil || manifest.Environment.ID != entry.Name() || validate(manifest.Environment) != nil {
			continue
		}
		if err = host.cleanupRuntime(manifest.Environment); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return errors.Join(cleanupErrors...)
}

// healthy combines the rendered/runtime invariants with the OpenVPN PKI
// directory mode and management-socket ownership/mode. Inspect uses the same
// predicate so the reconciler cannot treat a permissions drift as clean and
// skip Ensure.
func (host *NativeHost) healthy(environment DesiredEnvironment, bundle runtimeBundle) bool {
	return host.runtimeHealthy(environment, bundle) &&
		host.pkiDirectoryHealthy(environment) &&
		host.managementSocketHealthy(environment)
}

func (host *NativeHost) managementSocketPath(environment DesiredEnvironment) string {
	return filepath.Join(host.root, environment.ID, managementSocketName)
}

// managementSocketHealthy is deliberately read-only: Inspect must never chmod
// or otherwise mutate native state.
func (host *NativeHost) managementSocketHealthy(environment DesiredEnvironment) bool {
	if environment.Engine != "openvpn" {
		return true
	}
	return managementSocketMatches(host.managementSocketPath(environment), host.managementUID, host.managementGID)
}

func (host *NativeHost) hardenManagementSocket(environment DesiredEnvironment) error {
	if environment.Engine != "openvpn" {
		return nil
	}
	return prepareManagementSocket(host.managementSocketPath(environment), host.managementUID, host.managementGID)
}

func (host *NativeHost) pkiDirectoryHealthy(environment DesiredEnvironment) bool {
	if environment.Engine != "openvpn" {
		return true
	}
	info, err := os.Stat(filepath.Join(host.root, environment.ID, "pki"))
	return err == nil && info.IsDir() && info.Mode().Perm() == openVPNPKIDirectoryMode
}

func (host *NativeHost) ensurePKIDirectoryMode(environment DesiredEnvironment) error {
	if environment.Engine != "openvpn" {
		return nil
	}
	return os.Chmod(filepath.Join(host.root, environment.ID, "pki"), openVPNPKIDirectoryMode)
}

func (host *NativeHost) runtimeHealthy(environment DesiredEnvironment, bundle runtimeBundle) bool {
	raw, err := os.ReadFile(filepath.Join(host.root, environment.ID, "manifest.json"))
	if err != nil {
		return false
	}
	var manifest diskManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.Digest != bundle.digest || manifest.Environment.Revision != environment.Revision {
		return false
	}
	for name, expected := range bundleFiles(environment, bundle) {
		value, readErr := os.ReadFile(filepath.Join(host.root, environment.ID, name))
		if readErr != nil || string(value) != expected {
			return false
		}
	}
	if !ccdHealthy(filepath.Join(host.root, environment.ID), environment, bundle.ccd) {
		return false
	}
	unit, err := os.ReadFile(filepath.Join(host.units, unitName(environment)))
	if err != nil || string(unit) != bundle.unit {
		return false
	}
	link := linkFor(environment.ID)
	namespaceRules, err := host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "nft", "list", "table", "inet", "nexo_env")
	if err != nil || !nftRulesEqual(namespaceRules, bundle.namespaceFirewall) {
		return false
	}
	hostRules, err := host.runner.Run(nil, "nft", "list", "table", "inet", tableName(environment))
	if err != nil || !nftRulesEqual(hostRules, bundle.hostFirewall) {
		return false
	}
	namespaceAddress, err := host.runner.Run(nil, "ip", "-n", environment.NamespaceName, "addr", "show", "dev", link.NamespaceInterface)
	if err != nil || !strings.Contains(namespaceAddress, link.NamespaceAddress) {
		return false
	}
	hostAddress, err := host.runner.Run(nil, "ip", "addr", "show", "dev", link.HostInterface)
	if err != nil || !strings.Contains(hostAddress, link.HostAddress) {
		return false
	}
	if requiresHostTransit(environment) {
		route, routeErr := host.runner.Run(nil, "ip", "route", "show", "exact", environment.TunnelIPv4CIDR)
		if routeErr != nil || !strings.Contains(route, "via "+link.NamespaceAddress) || !strings.Contains(route, "dev "+link.HostInterface) {
			return false
		}
	}
	if _, err = host.runner.Run(nil, "systemctl", "is-active", "--quiet", unitName(environment)); err != nil {
		return false
	}
	if environment.Engine == "wireguard" {
		wgPublic, publicErr := host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "wg", "show", "wg0", "public-key")
		wgPort, portErr := host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "wg", "show", "wg0", "listen-port")
		localPublic, keyErr := host.WireGuardServerPublicKey(environment)
		if publicErr != nil || portErr != nil || keyErr != nil || strings.TrimSpace(wgPublic) != localPublic || strings.TrimSpace(wgPort) != fmt.Sprint(environment.ListenerPort) {
			return false
		}
		peers, peersErr := host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "wg", "show", "wg0", "peers")
		allowed, allowedErr := host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "wg", "show", "wg0", "allowed-ips")
		address, addressErr := host.runner.Run(nil, "ip", "-n", environment.NamespaceName, "addr", "show", "dev", "wg0")
		serverAddress, serverAddressErr := wireGuardServerAddress(environment.TunnelIPv4CIDR)
		if peersErr != nil || allowedErr != nil || addressErr != nil || serverAddressErr != nil || !wireGuardPeersEqual(peers, environment.WireGuard.Peers) || !wireGuardAllowedIPsEqual(allowed, environment.WireGuard.Peers) || !strings.Contains(address, serverAddress) {
			return false
		}
	} else {
		sockets, socketErr := host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "ss", "-H", "-u", "-l", "-n")
		if socketErr != nil || !strings.Contains(sockets, fmt.Sprintf(":%d", environment.ListenerPort)) {
			return false
		}
	}
	return true
}

func nftRulesEqual(actual, expected string) bool {
	normalize := func(value string) string {
		value = strings.ReplaceAll(value, "priority 0", "priority filter")
		value = regexp.MustCompile(`counter packets [0-9]+ bytes [0-9]+`).ReplaceAllString(value, "counter")
		value = strings.ReplaceAll(value, ";", "")
		return strings.Join(strings.Fields(value), " ")
	}
	return normalize(actual) == normalize(expected)
}

func (host *NativeHost) cleanupRuntime(environment DesiredEnvironment) error {
	var cleanupErrors []error
	link := linkFor(environment.ID)
	manifestRaw, readErr := os.ReadFile(filepath.Join(host.root, environment.ID, "manifest.json"))
	if readErr == nil {
		var manifest diskManifest
		unmarshalErr := json.Unmarshal(manifestRaw, &manifest)
		validateErr := validate(manifest.Environment)
		if unmarshalErr == nil && manifest.Environment.ID == environment.ID && validateErr == nil {
			if requiresHostTransit(manifest.Environment) {
				previous := manifest.Environment
				route, routeErr := host.runner.Run(nil, "ip", "route", "show", "exact", previous.TunnelIPv4CIDR)
				if routeErr != nil {
					cleanupErrors = append(cleanupErrors, routeErr)
				} else if strings.TrimSpace(route) != "" {
					owned := strings.Contains(route, "via "+link.NamespaceAddress) && strings.Contains(route, "dev "+link.HostInterface)
					if !owned {
						cleanupErrors = append(cleanupErrors, ErrRouteConflict)
					} else if _, routeErr = host.runner.Run(nil, "ip", "route", "del", previous.TunnelIPv4CIDR, "via", link.NamespaceAddress, "dev", link.HostInterface); routeErr != nil && !errors.Is(routeErr, ErrResourceNotFound) {
						cleanupErrors = append(cleanupErrors, routeErr)
					}
				}
			}
		} else {
			cleanupErrors = append(cleanupErrors, errors.Join(errors.New("invalid runtime manifest during cleanup"), unmarshalErr, validateErr))
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		cleanupErrors = append(cleanupErrors, readErr)
	}
	loadState, showErr := host.runner.Run(nil, "systemctl", "show", "--property=LoadState", "--value", unitName(environment))
	if showErr == nil && strings.TrimSpace(loadState) != "not-found" {
		if _, stopErr := host.runner.Run(nil, "systemctl", "stop", unitName(environment)); stopErr != nil {
			cleanupErrors = append(cleanupErrors, stopErr)
		}
	} else if showErr != nil {
		cleanupErrors = append(cleanupErrors, showErr)
	}
	tables, err := host.runner.Run(nil, "nft", "list", "tables", "inet")
	if err != nil {
		cleanupErrors = append(cleanupErrors, err)
	} else if nftTableListed(tables, tableName(environment)) {
		if _, err = host.runner.Run(nil, "nft", "delete", "table", "inet", tableName(environment)); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	listed, err := host.runner.Run(nil, "ip", "netns", "list")
	if err != nil {
		cleanupErrors = append(cleanupErrors, err)
	} else {
		for _, line := range strings.Split(listed, "\n") {
			fields := strings.Fields(line)
			if len(fields) > 0 && fields[0] == environment.NamespaceName {
				if _, err = host.runner.Run(nil, "ip", "netns", "delete", environment.NamespaceName); err != nil {
					cleanupErrors = append(cleanupErrors, err)
				}
				break
			}
		}
	}
	if _, err = host.runner.Run(nil, "ip", "link", "show", "dev", link.HostInterface); err == nil {
		if _, err = host.runner.Run(nil, "ip", "link", "delete", link.HostInterface); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	} else if !errors.Is(err, ErrResourceNotFound) {
		cleanupErrors = append(cleanupErrors, err)
	}
	if err = os.Remove(filepath.Join(host.units, unitName(environment))); err != nil && !errors.Is(err, os.ErrNotExist) {
		cleanupErrors = append(cleanupErrors, err)
	}
	if _, err = host.runner.Run(nil, "systemctl", "daemon-reload"); err != nil {
		cleanupErrors = append(cleanupErrors, err)
	}
	return errors.Join(cleanupErrors...)
}

func nftTableListed(tables, name string) bool {
	for _, line := range strings.Split(tables, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[0] == "table" && fields[1] == "inet" && fields[2] == name {
			return true
		}
	}
	return false
}

func (host *NativeHost) checkRouteAvailable(environment DesiredEnvironment, link Link) error {
	if !requiresHostTransit(environment) {
		return nil
	}
	route, err := host.runner.Run(nil, "ip", "route", "show", "exact", environment.TunnelIPv4CIDR)
	if err != nil {
		return err
	}
	if strings.TrimSpace(route) == "" {
		return nil
	}
	manifestRaw, err := os.ReadFile(filepath.Join(host.root, environment.ID, "manifest.json"))
	if err != nil {
		return ErrRouteConflict
	}
	var manifest diskManifest
	if json.Unmarshal(manifestRaw, &manifest) != nil || manifest.Environment.ID != environment.ID || validate(manifest.Environment) != nil || !requiresHostTransit(manifest.Environment) || manifest.Environment.TunnelIPv4CIDR != environment.TunnelIPv4CIDR {
		return ErrRouteConflict
	}
	if !strings.Contains(route, "via "+link.NamespaceAddress) || !strings.Contains(route, "dev "+link.HostInterface) {
		return ErrRouteConflict
	}
	return nil
}

func (host *NativeHost) render(environment DesiredEnvironment, link Link) (runtimeBundle, error) {
	prefix, err := netipPrefix(environment.TunnelIPv4CIDR)
	if err != nil {
		return runtimeBundle{}, err
	}
	networkAddress, network, err := net.ParseCIDR(environment.TunnelIPv4CIDR)
	if err != nil {
		return runtimeBundle{}, err
	}
	_ = networkAddress
	mask := net.IP(network.Mask).String()
	directory := filepath.Join(host.root, environment.ID)
	openvpn := ""
	wireguard := ""
	interfaceName := "tun0"
	if environment.Engine == "openvpn" {
		serverDirective := fmt.Sprintf("server %s %s", prefix, mask)
		// Static endpoint addresses live in the upper half of the pool, so the
		// dynamic pool must be reduced with nopool + ifconfig-pool. OpenVPN
		// refuses ifconfig-pool next to the default --server pool.
		if len(environment.OpenVPNGateways) > 0 {
			poolStart, poolEnd, poolErr := gatewayAddressPool(environment.TunnelIPv4CIDR)
			if poolErr != nil {
				return runtimeBundle{}, poolErr
			}
			serverDirective += fmt.Sprintf(" nopool\nifconfig-pool %s %s %s", poolStart, poolEnd, mask)
		}
		// Management is restricted to a per-environment Unix socket and to peer
		// uid 0 from the instant OpenVPN binds it. The agent re-verifies and
		// tightens the socket to root:root 0600 before its first use. No TCP
		// listener and no password file are rendered.
		openvpn = fmt.Sprintf("port %d\nproto udp\ndev tun\ntopology subnet\n%s\nuser nobody\ngroup nobody\npersist-key\npersist-tun\nkeepalive 10 60\ntls-version-min 1.2\ntls-cert-profile preferred\ndata-ciphers AES-256-GCM:AES-128-GCM\nauth SHA256\nca %s/pki/ca.crt\ncert %s/pki/server.crt\nkey %s/pki/server.key\ncrl-verify %s/pki/crl.pem\ntls-crypt %s/pki/tls-crypt.key\nmanagement %s/%s unix\nmanagement-client-user root\ndh none\nscript-security 1\nverb 3\nexplicit-exit-notify 1\n", environment.ListenerPort, serverDirective, directory, directory, directory, directory, directory, directory, managementSocketName)
	} else {
		interfaceName = "wg0"
		serverAddress, addressErr := wireGuardServerAddress(environment.TunnelIPv4CIDR)
		if addressErr != nil {
			return runtimeBundle{}, addressErr
		}
		var config strings.Builder
		fmt.Fprintf(&config, "[Interface]\nAddress = %s\nListenPort = %d\nMTU = %d\n", serverAddress, environment.ListenerPort, environment.WireGuard.MTU)
		for _, peer := range environment.WireGuard.Peers {
			fmt.Fprintf(&config, "\n[Peer]\nPublicKey = %s\nAllowedIPs = %s\nPersistentKeepalive = %d\n", peer.PublicKey, strings.Join(peer.AllowedIPs, ", "), peer.PersistentKeepaliveSeconds)
		}
		wireguard = config.String()
	}
	accessRules := append([]PrivateAccessRule(nil), environment.PrivateAccess...)
	sort.Slice(accessRules, func(i, j int) bool {
		if accessRules[i].Address != accessRules[j].Address {
			return accessRules[i].Address < accessRules[j].Address
		}
		if accessRules[i].Protocol != accessRules[j].Protocol {
			return accessRules[i].Protocol < accessRules[j].Protocol
		}
		if accessRules[i].PortStart != accessRules[j].PortStart {
			return accessRules[i].PortStart < accessRules[j].PortStart
		}
		return accessRules[i].PortEnd < accessRules[j].PortEnd
	})
	var forwardRules strings.Builder
	var returnRules strings.Builder
	var hostAccessRules strings.Builder
	var hostReturnRules strings.Builder
	var hostLocalInputRules strings.Builder
	var hostLocalOutputRules strings.Builder
	var gatewayForwardRules strings.Builder
	var gatewayReturnRules strings.Builder
	var gatewayDropRules strings.Builder
	var masqueradeRules strings.Builder
	ccd := map[string]string{}
	pushedRoutes := map[string]struct{}{}
	gateways := append([]OpenVPNGateway(nil), environment.OpenVPNGateways...)
	sort.Slice(gateways, func(i, j int) bool { return gateways[i].DeviceID < gateways[j].DeviceID })
	dnsServers := map[string]struct{}{}
	dnsSuffixes := map[string]struct{}{}
	if len(gateways) > 0 {
		openvpn += fmt.Sprintf("client-config-dir %s/ccd\n", directory)
	}
	for _, gateway := range gateways {
		networks := append([]string(nil), gateway.Networks...)
		sort.Strings(networks)
		var config strings.Builder
		for _, raw := range networks {
			networkAddress, network, parseErr := net.ParseCIDR(raw)
			if parseErr != nil {
				return runtimeBundle{}, parseErr
			}
			mask := net.IP(network.Mask).String()
			canonical := network.String()
			fmt.Fprintf(&config, "iroute %s %s\n", networkAddress.Mask(network.Mask), mask)
			openvpn += fmt.Sprintf("route %s %s\n", networkAddress.Mask(network.Mask), mask)
			gatewayReturnRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ct state established,related ip saddr %s ip daddr %s accept; ", interfaceName, interfaceName, canonical, environment.TunnelIPv4CIDR))
			gatewayDropRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ip saddr %s ip daddr %s counter drop; ", interfaceName, interfaceName, environment.TunnelIPv4CIDR, canonical))
			if gateway.ReturnMode == "snat" {
				masqueradeRules.WriteString(fmt.Sprintf("ip saddr %s ip daddr %s masquerade; ", environment.TunnelIPv4CIDR, canonical))
			}
		}
		ccd["nexo:"+gateway.DeviceID] = config.String()
		for _, server := range gateway.DNSServers {
			dnsServers[server] = struct{}{}
		}
		for _, suffix := range gateway.DNSSuffixes {
			dnsSuffixes[suffix] = struct{}{}
		}
	}
	var access GatewayAccess
	if environment.GatewayAccess != nil {
		access = *environment.GatewayAccess
	}
	endpoints := append([]GatewayAccessEndpoint(nil), access.Endpoints...)
	sort.Slice(endpoints, func(i, j int) bool { return endpoints[i].DeviceID < endpoints[j].DeviceID })
	activeDevices := map[string]struct{}{}
	for _, rule := range access.Rules {
		activeDevices[rule.DeviceID] = struct{}{}
	}
	tunnelByDevice := make(map[string]string, len(endpoints))
	for _, endpoint := range endpoints {
		if len(endpoint.AllowedLans) == 0 {
			continue
		}
		if _, authorized := activeDevices[endpoint.DeviceID]; !authorized {
			continue
		}
		lans := append([]string(nil), endpoint.AllowedLans...)
		sort.Strings(lans)
		var config strings.Builder
		fmt.Fprintf(&config, "ifconfig-push %s %s\n", endpoint.TunnelIP, mask)
		for _, raw := range lans {
			networkAddress, network, parseErr := net.ParseCIDR(raw)
			if parseErr != nil {
				return runtimeBundle{}, parseErr
			}
			fmt.Fprintf(&config, "push \"route %s %s\"\n", networkAddress.Mask(network.Mask), net.IP(network.Mask).String())
		}
		ccd["nexo:"+endpoint.DeviceID] = config.String()
		tunnelByDevice[endpoint.DeviceID] = endpoint.TunnelIP
	}
	gatewayRules := append([]GatewayAccessRule(nil), access.Rules...)
	sort.Slice(gatewayRules, func(i, j int) bool {
		if gatewayRules[i].DeviceID != gatewayRules[j].DeviceID {
			return gatewayRules[i].DeviceID < gatewayRules[j].DeviceID
		}
		if gatewayRules[i].Address != gatewayRules[j].Address {
			return gatewayRules[i].Address < gatewayRules[j].Address
		}
		if gatewayRules[i].Protocol != gatewayRules[j].Protocol {
			return gatewayRules[i].Protocol < gatewayRules[j].Protocol
		}
		if gatewayRules[i].PortStart != gatewayRules[j].PortStart {
			return gatewayRules[i].PortStart < gatewayRules[j].PortStart
		}
		return gatewayRules[i].PortEnd < gatewayRules[j].PortEnd
	})
	for _, rule := range gatewayRules {
		tunnelIP, exists := tunnelByDevice[rule.DeviceID]
		if !exists {
			return runtimeBundle{}, errors.New("invalid gateway access rule")
		}
		if rule.Protocol == "icmp" {
			gatewayForwardRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ip saddr %s ip daddr %s icmp type echo-request accept; ", interfaceName, interfaceName, tunnelIP, rule.Address))
			continue
		}
		gatewayForwardRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ip saddr %s ip daddr %s %s dport %d-%d accept; ", interfaceName, interfaceName, tunnelIP, rule.Address, rule.Protocol, rule.PortStart, rule.PortEnd))
	}
	suffixes := make([]string, 0, len(dnsSuffixes))
	for suffix := range dnsSuffixes {
		suffixes = append(suffixes, suffix)
	}
	sort.Strings(suffixes)
	for _, suffix := range suffixes {
		openvpn += fmt.Sprintf("push \"dhcp-option DOMAIN %s\"\n", suffix)
	}
	servers := make([]string, 0, len(dnsServers))
	for server := range dnsServers {
		servers = append(servers, server)
	}
	sort.Strings(servers)
	for _, server := range servers {
		openvpn += fmt.Sprintf("push \"route %s 255.255.255.255\"\n", server)
		openvpn += fmt.Sprintf("push \"dhcp-option DNS %s\"\n", server)
		pushedRoutes[server+"/32"] = struct{}{}
		for _, protocol := range []string{"tcp", "udp"} {
			forwardRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ip saddr %s ip daddr %s %s dport 53 accept; ", interfaceName, link.NamespaceInterface, environment.TunnelIPv4CIDR, server, protocol))
			returnRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ct state established,related ip saddr %s %s sport 53 ip daddr %s accept; ", link.NamespaceInterface, interfaceName, server, protocol, environment.TunnelIPv4CIDR))
			hostAccessRules.WriteString(fmt.Sprintf("iifname \"%s\" ip saddr %s ip daddr %s %s dport 53 accept; ", link.HostInterface, environment.TunnelIPv4CIDR, server, protocol))
			hostReturnRules.WriteString(fmt.Sprintf("oifname \"%s\" ct state established,related ip saddr %s %s sport 53 ip daddr %s accept; ", link.HostInterface, server, protocol, environment.TunnelIPv4CIDR))
			hostLocalInputRules.WriteString(fmt.Sprintf("iifname \"%s\" ip saddr %s ip daddr %s %s dport 53 accept; ", link.HostInterface, environment.TunnelIPv4CIDR, server, protocol))
			hostLocalOutputRules.WriteString(fmt.Sprintf("oifname \"%s\" ct state established,related ip saddr %s %s sport 53 ip daddr %s accept; ", link.HostInterface, server, protocol, environment.TunnelIPv4CIDR))
		}
	}
	for _, rule := range accessRules {
		address := netip.MustParseAddr(rule.Address)
		if environment.Engine == "openvpn" {
			if _, exists := pushedRoutes[address.String()+"/32"]; !exists {
				openvpn += fmt.Sprintf("push \"route %s 255.255.255.255\"\n", address.String())
				pushedRoutes[address.String()+"/32"] = struct{}{}
			}
		}
		if rule.Protocol == "icmp" {
			forwardRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ip saddr %s ip daddr %s icmp type echo-request accept; ", interfaceName, link.NamespaceInterface, environment.TunnelIPv4CIDR, address.String()))
			returnRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ct state established,related ip saddr %s icmp type echo-reply ip daddr %s accept; ", link.NamespaceInterface, interfaceName, address.String(), environment.TunnelIPv4CIDR))
			hostAccessRules.WriteString(fmt.Sprintf("iifname \"%s\" ip saddr %s ip daddr %s icmp type echo-request accept; ", link.HostInterface, environment.TunnelIPv4CIDR, address.String()))
			hostReturnRules.WriteString(fmt.Sprintf("oifname \"%s\" ct state established,related ip saddr %s icmp type echo-reply ip daddr %s accept; ", link.HostInterface, address.String(), environment.TunnelIPv4CIDR))
			hostLocalInputRules.WriteString(fmt.Sprintf("iifname \"%s\" ip saddr %s ip daddr %s icmp type echo-request accept; ", link.HostInterface, environment.TunnelIPv4CIDR, address.String()))
			hostLocalOutputRules.WriteString(fmt.Sprintf("oifname \"%s\" ct state established,related ip saddr %s icmp type echo-reply ip daddr %s accept; ", link.HostInterface, address.String(), environment.TunnelIPv4CIDR))
			continue
		}
		forwardRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ip saddr %s ip daddr %s %s dport %d-%d accept; ", interfaceName, link.NamespaceInterface, environment.TunnelIPv4CIDR, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd))
		returnRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"%s\" ct state established,related ip saddr %s %s sport %d-%d ip daddr %s accept; ", link.NamespaceInterface, interfaceName, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd, environment.TunnelIPv4CIDR))
		hostAccessRules.WriteString(fmt.Sprintf("iifname \"%s\" ip saddr %s ip daddr %s %s dport %d-%d accept; ", link.HostInterface, environment.TunnelIPv4CIDR, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd))
		hostReturnRules.WriteString(fmt.Sprintf("oifname \"%s\" ct state established,related ip saddr %s %s sport %d-%d ip daddr %s accept; ", link.HostInterface, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd, environment.TunnelIPv4CIDR))
		hostLocalInputRules.WriteString(fmt.Sprintf("iifname \"%s\" ip saddr %s ip daddr %s %s dport %d-%d accept; ", link.HostInterface, environment.TunnelIPv4CIDR, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd))
		hostLocalOutputRules.WriteString(fmt.Sprintf("oifname \"%s\" ct state established,related ip saddr %s %s sport %d-%d ip daddr %s accept; ", link.HostInterface, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd, environment.TunnelIPv4CIDR))
	}
	postrouting := ""
	if masqueradeRules.Len() > 0 {
		postrouting = fmt.Sprintf(" chain postrouting { type nat hook postrouting priority srcnat; policy accept; %s}\n", masqueradeRules.String())
	}
	namespaceFirewall := fmt.Sprintf("table inet nexo_env {\n chain input { type filter hook input priority 0; policy drop; iifname \"lo\" accept; ct state established,related accept; iifname \"%s\" udp dport %d accept; }\n chain forward { type filter hook forward priority 0; policy drop; %s%s%s%s%s iifname \"%s\" oifname \"%s\" ip saddr %s counter drop; }\n chain output { type filter hook output priority 0; policy drop; oifname \"lo\" accept; ct state established,related accept; ip daddr 169.254.169.254 drop; oifname \"%s\" udp sport %d accept; }\n%s}\n", link.NamespaceInterface, environment.ListenerPort, gatewayForwardRules.String(), gatewayReturnRules.String(), forwardRules.String(), returnRules.String(), gatewayDropRules.String(), interfaceName, link.NamespaceInterface, environment.TunnelIPv4CIDR, link.NamespaceInterface, environment.ListenerPort, postrouting)
	hostFirewall := fmt.Sprintf("table inet %s {\n chain prerouting { type nat hook prerouting priority dstnat; policy accept; fib daddr type local udp dport %d dnat ip to %s:%d; }\n chain input { type filter hook input priority filter; policy accept; %siifname \"%s\" counter drop; }\n chain output { type filter hook output priority filter; policy accept; %soifname \"%s\" counter drop; }\n chain forward { type filter hook forward priority filter; policy accept; %s%s oifname \"%s\" ip daddr %s udp dport %d accept; iifname \"%s\" ip saddr %s udp sport %d accept; iifname \"%s\" counter drop; oifname \"%s\" counter drop; }\n}\n", tableName(environment), environment.ListenerPort, link.NamespaceAddress, environment.ListenerPort, hostLocalInputRules.String(), link.HostInterface, hostLocalOutputRules.String(), link.HostInterface, hostReturnRules.String(), hostAccessRules.String(), link.HostInterface, link.NamespaceAddress, environment.ListenerPort, link.HostInterface, link.NamespaceAddress, environment.ListenerPort, link.HostInterface, link.HostInterface)
	unit := renderUnit(environment, directory, serverAddressForUnit(environment), interfaceName)
	canonical, _ := json.Marshal(environment)
	sum := sha256.New()
	for _, part := range [][]byte{canonical, []byte(openvpn), []byte(wireguard), []byte(namespaceFirewall), []byte(hostFirewall), []byte(unit)} {
		sum.Write(part)
		sum.Write([]byte{0})
	}
	ccdNames := make([]string, 0, len(ccd))
	for name := range ccd {
		ccdNames = append(ccdNames, name)
	}
	sort.Strings(ccdNames)
	for _, name := range ccdNames {
		sum.Write([]byte(name))
		sum.Write([]byte{0})
		sum.Write([]byte(ccd[name]))
		sum.Write([]byte{0})
	}
	digest := hex.EncodeToString(sum.Sum(nil))
	return runtimeBundle{openvpn: openvpn, wireguard: wireguard, namespaceFirewall: namespaceFirewall, hostFirewall: hostFirewall, unit: unit, ccd: ccd, digest: digest}, nil
}

func bundleFiles(environment DesiredEnvironment, bundle runtimeBundle) map[string]string {
	configName, config := "openvpn.conf", bundle.openvpn
	if environment.Engine == "wireguard" {
		configName, config = "wireguard.conf", bundle.wireguard
	}
	return map[string]string{configName: config, "namespace.nft": bundle.namespaceFirewall, "host.nft": bundle.hostFirewall, "unit.service": bundle.unit}
}

func renderUnit(environment DesiredEnvironment, directory, serverAddress, interfaceName string) string {
	if environment.Engine == "openvpn" {
		// ProtectSystem=strict makes the whole filesystem read-only for the
		// unit, so the management socket needs an explicit writable path. Scope
		// it to this instance's environment directory, never the parent that
		// contains every tenant environment.
		return fmt.Sprintf("[Unit]\nDescription=NEXO OpenVPN environment %s\nAfter=network-online.target\n\n[Service]\nType=simple\nNetworkNamespacePath=/run/netns/%s\nExecStart=/usr/sbin/openvpn --config %s/openvpn.conf\nRestart=on-failure\nRestartSec=3s\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nReadWritePaths=%s\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK\nCapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_SETUID CAP_SETGID CAP_SETPCAP\nAmbientCapabilities=\nDevicePolicy=closed\nDeviceAllow=/dev/net/tun rw\nMemoryMax=96M\nCPUQuota=25%%\nTasksMax=64\n\n", environment.ID, environment.NamespaceName, directory, directory)
	}
	var unit strings.Builder
	fmt.Fprintf(&unit, "[Unit]\nDescription=NEXO WireGuard environment %s\nAfter=network-online.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nNetworkNamespacePath=/run/netns/%s\n", environment.ID, environment.NamespaceName)
	fmt.Fprintf(&unit, "ExecStartPre=/usr/sbin/ip link add %s type wireguard\n", interfaceName)
	fmt.Fprintf(&unit, "ExecStartPre=/usr/sbin/ip address add %s dev %s\n", serverAddress, interfaceName)
	fmt.Fprintf(&unit, "ExecStartPre=/usr/sbin/ip link set dev %s mtu %d\n", interfaceName, environment.WireGuard.MTU)
	fmt.Fprintf(&unit, "ExecStartPre=/usr/sbin/ip link set dev %s up\n", interfaceName)
	keyPath := filepath.Join(directory, "wireguard", "server.key")
	fmt.Fprintf(&unit, "ExecStart=/usr/bin/wg set %s private-key %s listen-port %d\n", interfaceName, keyPath, environment.ListenerPort)
	for _, peer := range environment.WireGuard.Peers {
		keepalive := "off"
		if peer.PersistentKeepaliveSeconds != 0 {
			keepalive = fmt.Sprint(peer.PersistentKeepaliveSeconds)
		}
		fmt.Fprintf(&unit, "ExecStart=/usr/bin/wg set %s peer %s allowed-ips %s persistent-keepalive %s\n", interfaceName, peer.PublicKey, strings.Join(peer.AllowedIPs, ","), keepalive)
	}
	fmt.Fprintf(&unit, "ExecStop=/usr/sbin/ip link delete %s\n", interfaceName)
	unit.WriteString("UMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK\nCapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE\nAmbientCapabilities=\nDevicePolicy=closed\nMemoryMax=96M\nCPUQuota=25%\nTasksMax=64\n\n")
	return unit.String()
}

func serverAddressForUnit(environment DesiredEnvironment) string {
	if environment.Engine != "wireguard" {
		return ""
	}
	address, _ := wireGuardServerAddress(environment.TunnelIPv4CIDR)
	return address
}

func wireGuardPeersEqual(actual string, desired []WireGuardPeer) bool {
	keys := strings.Fields(actual)
	if len(keys) != len(desired) {
		return false
	}
	want := make([]string, len(desired))
	for index, peer := range desired {
		want[index] = peer.PublicKey
	}
	sort.Strings(keys)
	sort.Strings(want)
	return strings.Join(keys, "\n") == strings.Join(want, "\n")
}

func wireGuardAllowedIPsEqual(actual string, desired []WireGuardPeer) bool {
	want := make(map[string]string, len(desired))
	for _, peer := range desired {
		want[peer.PublicKey] = strings.Join(peer.AllowedIPs, ",")
	}
	seen := make(map[string]string, len(desired))
	for _, line := range strings.Split(strings.TrimSpace(actual), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			if strings.TrimSpace(line) == "" && len(desired) == 0 {
				return true
			}
			return false
		}
		seen[fields[0]] = fields[1]
	}
	if len(seen) != len(want) {
		return false
	}
	for key, allowed := range want {
		if seen[key] != allowed {
			return false
		}
	}
	return true
}

func ensureWireGuardServerKey(path string) (string, error) {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return "", err
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		private, generateErr := ecdh.X25519().GenerateKey(rand.Reader)
		if generateErr != nil {
			return "", errors.New("wireguard key generation failed")
		}
		contents := []byte(base64.StdEncoding.EncodeToString(private.Bytes()) + "\n")
		file, createErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if createErr != nil && !errors.Is(createErr, os.ErrExist) {
			return "", errors.New("wireguard key persistence failed")
		}
		if createErr == nil {
			_, writeErr := file.Write(contents)
			syncErr := file.Sync()
			closeErr := file.Close()
			if writeErr != nil || syncErr != nil || closeErr != nil {
				_ = os.Remove(path)
				return "", errors.New("wireguard key persistence failed")
			}
		}
	} else if err != nil {
		return "", errors.New("wireguard key unavailable")
	}
	return readWireGuardServerKey(path)
}

func readWireGuardServerKey(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return "", errors.New("wireguard key unavailable")
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("wireguard key unavailable")
	}
	privateBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil || len(privateBytes) != 32 {
		return "", errors.New("wireguard key invalid")
	}
	private, err := ecdh.X25519().NewPrivateKey(privateBytes)
	if err != nil {
		return "", errors.New("wireguard key invalid")
	}
	return base64.StdEncoding.EncodeToString(private.PublicKey().Bytes()), nil
}

func netipPrefix(value string) (string, error) {
	_, network, err := net.ParseCIDR(value)
	if err != nil {
		return "", err
	}
	return network.IP.String(), nil
}
func gatewayAddressPool(cidr string) (string, string, error) {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil || !prefix.Addr().Is4() || prefix.Bits() > 29 {
		return "", "", errors.New("invalid gateway address pool")
	}
	baseBytes := prefix.Masked().Addr().As4()
	base := binary.BigEndian.Uint32(baseBytes[:])
	size := uint32(1) << uint(32-prefix.Bits())
	start := base + 2
	end := base + size/2 - 1
	if end < start {
		end = start
	}
	address := func(value uint32) string {
		var raw [4]byte
		binary.BigEndian.PutUint32(raw[:], value)
		return netip.AddrFrom4(raw).String()
	}
	return address(start), address(end), nil
}
func tableName(environment DesiredEnvironment) string {
	return "nx_" + strings.TrimPrefix(environment.NamespaceName, "nexo-")
}
func unitName(environment DesiredEnvironment) string {
	return "nexo-vpn-" + strings.TrimPrefix(environment.NamespaceName, "nexo-") + ".service"
}

func ensurePKI(directory string, environment DesiredEnvironment) error {
	complete := true
	for _, name := range []string{"ca.crt", "ca.key", "server.crt", "server.key", "tls-crypt.key"} {
		if _, err := os.Stat(filepath.Join(directory, name)); errors.Is(err, os.ErrNotExist) {
			complete = false
		} else if err != nil {
			return err
		}
	}
	if complete {
		if err := validatePKI(directory); err != nil {
			return err
		}
		return ensureEmptyCRL(directory)
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	caTemplate := x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "NEXO environment " + environment.ID + " CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(1, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	caDER, err := x509.CreateCertificate(rand.Reader, &caTemplate, &caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	serverTemplate := x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: environment.ID}, NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(1, 0, 0), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	serverDER, err := x509.CreateCertificate(rand.Reader, &serverTemplate, &caTemplate, &serverKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	serverRaw, err := x509.MarshalECPrivateKey(serverKey)
	if err != nil {
		return err
	}
	caRaw, err := x509.MarshalECPrivateKey(caKey)
	if err != nil {
		return err
	}
	static := make([]byte, 256)
	if _, err = rand.Read(static); err != nil {
		return err
	}
	keyText := "-----BEGIN OpenVPN Static key V1-----\n"
	encoded := hex.EncodeToString(static)
	for len(encoded) > 0 {
		size := 32
		if len(encoded) < size {
			size = len(encoded)
		}
		keyText += encoded[:size] + "\n"
		encoded = encoded[size:]
	}
	keyText += "-----END OpenVPN Static key V1-----\n"
	for name, value := range map[string][]byte{"ca.crt": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), "ca.key": pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: caRaw}), "server.crt": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER}), "server.key": pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: serverRaw}), "tls-crypt.key": []byte(keyText)} {
		mode := os.FileMode(0600)
		if strings.HasSuffix(name, ".crt") {
			mode = 0644
		}
		if err = atomicWrite(directory, name, value, mode); err != nil {
			return err
		}
	}
	if err = ensureEmptyCRL(directory); err != nil {
		return err
	}
	return validatePKI(directory)
}

func validatePKI(directory string) error {
	readPEM := func(name, kind string, mode os.FileMode) ([]byte, error) {
		path := filepath.Join(directory, name)
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			return nil, errors.New("invalid pki file")
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		block, rest := pem.Decode(raw)
		if block == nil || block.Type != kind || len(bytes.TrimSpace(rest)) != 0 {
			return nil, errors.New("invalid pki pem")
		}
		return block.Bytes, nil
	}
	caDER, err := readPEM("ca.crt", "CERTIFICATE", 0644)
	if err != nil {
		return err
	}
	caKeyDER, err := readPEM("ca.key", "EC PRIVATE KEY", 0600)
	if err != nil {
		return err
	}
	serverDER, err := readPEM("server.crt", "CERTIFICATE", 0644)
	if err != nil {
		return err
	}
	serverKeyDER, err := readPEM("server.key", "EC PRIVATE KEY", 0600)
	if err != nil {
		return err
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil || !ca.IsCA {
		return errors.New("invalid ca certificate")
	}
	caKey, err := x509.ParseECPrivateKey(caKeyDER)
	if err != nil {
		return errors.New("invalid ca key")
	}
	server, err := x509.ParseCertificate(serverDER)
	if err != nil {
		return errors.New("invalid server certificate")
	}
	serverKey, err := x509.ParseECPrivateKey(serverKeyDER)
	if err != nil {
		return errors.New("invalid server key")
	}
	if err = server.CheckSignatureFrom(ca); err != nil {
		return errors.New("invalid server certificate chain")
	}
	publicEqual := func(left, right any) bool {
		leftDER, leftErr := x509.MarshalPKIXPublicKey(left)
		rightDER, rightErr := x509.MarshalPKIXPublicKey(right)
		return leftErr == nil && rightErr == nil && bytes.Equal(leftDER, rightDER)
	}
	if !publicEqual(ca.PublicKey, &caKey.PublicKey) || !publicEqual(server.PublicKey, &serverKey.PublicKey) {
		return errors.New("pki key mismatch")
	}
	staticPath := filepath.Join(directory, "tls-crypt.key")
	staticInfo, err := os.Stat(staticPath)
	if err != nil || staticInfo.Mode().Perm() != 0600 {
		return errors.New("invalid static key file")
	}
	staticRaw, err := os.ReadFile(staticPath)
	if err != nil {
		return err
	}
	staticText := strings.TrimSpace(string(staticRaw))
	staticText = strings.TrimPrefix(staticText, "-----BEGIN OpenVPN Static key V1-----")
	staticText = strings.TrimSuffix(staticText, "-----END OpenVPN Static key V1-----")
	staticBytes, err := hex.DecodeString(strings.Join(strings.Fields(staticText), ""))
	if err != nil || len(staticBytes) != 256 {
		return errors.New("invalid static key")
	}
	return nil
}

func syncCCD(directory string, desired map[string]string) error {
	path := filepath.Join(directory, "ccd")
	info, err := os.Lstat(path)
	if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return errors.New("invalid ccd directory")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entries, err := os.ReadDir(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return errors.New("invalid ccd entry")
		}
		if _, keep := desired[entry.Name()]; !keep {
			if err = os.Remove(filepath.Join(path, entry.Name())); err != nil {
				return err
			}
		}
	}
	if len(desired) == 0 {
		if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err = os.MkdirAll(path, 0755); err != nil {
		return err
	}
	if err = os.Chmod(path, 0755); err != nil {
		return err
	}
	for name, content := range desired {
		if !strings.HasPrefix(name, "nexo:") || !uuidPattern.MatchString(strings.TrimPrefix(name, "nexo:")) {
			return errors.New("invalid ccd name")
		}
		if err = atomicWrite(path, name, []byte(content), 0644); err != nil {
			return err
		}
	}
	return os.Chmod(path, 0755)
}

func environmentDirectoryMode(environment DesiredEnvironment) os.FileMode {
	if environment.Engine == "openvpn" {
		return openVPNEnvironmentDirectoryMode
	}
	return 0700
}

func ccdHealthy(directory string, environment DesiredEnvironment, desired map[string]string) bool {
	root, err := os.Stat(directory)
	wantRootMode := os.FileMode(0700)
	if environment.Engine == "openvpn" {
		wantRootMode = openVPNEnvironmentDirectoryMode
	}
	if err != nil || !root.IsDir() || root.Mode().Perm() != wantRootMode {
		return false
	}
	path := filepath.Join(directory, "ccd")
	ccdInfo, lstatErr := os.Lstat(path)
	if lstatErr == nil && (!ccdInfo.IsDir() || ccdInfo.Mode()&os.ModeSymlink != 0) {
		return false
	}
	entries, err := os.ReadDir(path)
	if len(desired) == 0 {
		return errors.Is(err, os.ErrNotExist)
	}
	if err != nil {
		return false
	}
	directoryInfo, err := os.Stat(path)
	if err != nil || directoryInfo.Mode().Perm() != 0755 || len(entries) != len(desired) {
		return false
	}
	for _, entry := range entries {
		expected, exists := desired[entry.Name()]
		if !exists || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return false
		}
		info, infoErr := entry.Info()
		value, readErr := os.ReadFile(filepath.Join(path, entry.Name()))
		if infoErr != nil || readErr != nil || info.Mode().Perm() != 0644 || string(value) != expected {
			return false
		}
	}
	return true
}

func atomicJSON(directory, name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicWrite(directory, name, append(raw, '\n'), 0600)
}
func atomicWrite(directory, name string, value []byte, mode os.FileMode) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".nexo-tmp-")
	if err != nil {
		return err
	}
	path := temporary.Name()
	defer os.Remove(path)
	if err = temporary.Chmod(mode); err == nil {
		_, err = temporary.Write(value)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(path, filepath.Join(directory, name)); err != nil {
		return err
	}
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return err
	}
	err = directoryHandle.Sync()
	if closeErr := directoryHandle.Close(); err == nil {
		err = closeErr
	}
	return err
}
