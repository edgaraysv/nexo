//go:build linux

package vpnruntime

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
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
)

type commandRunner interface {
	Run([]byte, string, ...string) (string, error)
}
type execRunner struct{}

func (execRunner) Run(input []byte, name string, arguments ...string) (string, error) {
	allowed := map[string]bool{"ip": true, "nft": true, "systemctl": true, "sysctl": true}
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
}
type diskManifest struct {
	Environment DesiredEnvironment `json:"environment"`
	Digest      string             `json:"digest"`
}
type runtimeBundle struct{ openvpn, namespaceFirewall, hostFirewall, unit, digest string }

func NewNativeHost() *NativeHost {
	return &NativeHost{root: nativeRoot, units: transientUnits, forwardingPath: "/proc/sys/net/ipv4/ip_forward", runner: execRunner{}}
}

func (host *NativeHost) Ensure(environment DesiredEnvironment, link Link) (digest string, returned error) {
	forwarding, err := os.ReadFile(host.forwardingPath)
	if err != nil || strings.TrimSpace(string(forwarding)) != "1" {
		return "", ErrForwardingDisabled
	}
	bundle, err := host.render(environment, link)
	if err != nil {
		return "", err
	}
	if host.healthy(environment, bundle) {
		return bundle.digest, nil
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
	directory := filepath.Join(host.root, environment.ID)
	if err = os.MkdirAll(filepath.Join(directory, "pki"), 0700); err != nil {
		return "", err
	}
	if err = ensurePKI(filepath.Join(directory, "pki"), environment); err != nil {
		return "", err
	}
	for name, value := range map[string]string{"openvpn.conf": bundle.openvpn, "namespace.nft": bundle.namespaceFirewall, "host.nft": bundle.hostFirewall, "unit.service": bundle.unit} {
		if err = atomicWrite(directory, name, []byte(value), 0600); err != nil {
			return "", err
		}
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
	if len(environment.PrivateAccess) > 0 {
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
		if host.healthy(environment, bundle) {
			return bundle.digest, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return "", errors.New("runtime did not become healthy")
}

// Inspect reuses the renderer and health probe of Ensure without mutating any
// native state, so the reconciler can decide whether a repair is really needed.
func (host *NativeHost) Inspect(environment DesiredEnvironment, link Link) (string, bool, error) {
	bundle, err := host.render(environment, link)
	if err != nil {
		return "", false, err
	}
	if !host.healthy(environment, bundle) {
		return "", false, nil
	}
	return bundle.digest, true, nil
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

func (host *NativeHost) healthy(environment DesiredEnvironment, bundle runtimeBundle) bool {
	raw, err := os.ReadFile(filepath.Join(host.root, environment.ID, "manifest.json"))
	if err != nil {
		return false
	}
	var manifest diskManifest
	if json.Unmarshal(raw, &manifest) != nil || manifest.Digest != bundle.digest || manifest.Environment.Revision != environment.Revision {
		return false
	}
	for name, expected := range map[string]string{"openvpn.conf": bundle.openvpn, "namespace.nft": bundle.namespaceFirewall, "host.nft": bundle.hostFirewall, "unit.service": bundle.unit} {
		value, readErr := os.ReadFile(filepath.Join(host.root, environment.ID, name))
		if readErr != nil || string(value) != expected {
			return false
		}
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
	if len(environment.PrivateAccess) > 0 {
		route, routeErr := host.runner.Run(nil, "ip", "route", "show", "exact", environment.TunnelIPv4CIDR)
		if routeErr != nil || !strings.Contains(route, "via "+link.NamespaceAddress) || !strings.Contains(route, "dev "+link.HostInterface) {
			return false
		}
	}
	if _, err = host.runner.Run(nil, "systemctl", "is-active", "--quiet", unitName(environment)); err != nil {
		return false
	}
	sockets, err := host.runner.Run(nil, "ip", "netns", "exec", environment.NamespaceName, "ss", "-H", "-u", "-l", "-n")
	if err != nil || !strings.Contains(sockets, fmt.Sprintf(":%d", environment.ListenerPort)) {
		return false
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
			if len(manifest.Environment.PrivateAccess) > 0 {
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
	if len(environment.PrivateAccess) == 0 {
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
	if json.Unmarshal(manifestRaw, &manifest) != nil || manifest.Environment.ID != environment.ID || validate(manifest.Environment) != nil || len(manifest.Environment.PrivateAccess) == 0 || manifest.Environment.TunnelIPv4CIDR != environment.TunnelIPv4CIDR {
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
	openvpn := fmt.Sprintf("port %d\nproto udp\ndev tun\ntopology subnet\nserver %s %s\nuser nobody\ngroup nobody\npersist-key\npersist-tun\nkeepalive 10 60\ntls-version-min 1.2\ntls-cert-profile preferred\ndata-ciphers AES-256-GCM:AES-128-GCM\nauth SHA256\nca %s/pki/ca.crt\ncert %s/pki/server.crt\nkey %s/pki/server.key\ncrl-verify %s/pki/crl.pem\ntls-crypt %s/pki/tls-crypt.key\ndh none\nscript-security 1\nverb 3\nexplicit-exit-notify 1\n", environment.ListenerPort, prefix, mask, directory, directory, directory, directory, directory)
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
	for _, rule := range accessRules {
		address := netip.MustParseAddr(rule.Address)
		openvpn += fmt.Sprintf("push \"route %s 255.255.255.255\"\n", address.String())
		forwardRules.WriteString(fmt.Sprintf("iifname \"tun0\" oifname \"%s\" ip saddr %s ip daddr %s %s dport %d-%d accept; ", link.NamespaceInterface, environment.TunnelIPv4CIDR, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd))
		returnRules.WriteString(fmt.Sprintf("iifname \"%s\" oifname \"tun0\" ct state established,related ip saddr %s %s sport %d-%d ip daddr %s accept; ", link.NamespaceInterface, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd, environment.TunnelIPv4CIDR))
		hostAccessRules.WriteString(fmt.Sprintf("iifname \"%s\" ip saddr %s ip daddr %s %s dport %d-%d accept; ", link.HostInterface, environment.TunnelIPv4CIDR, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd))
		hostReturnRules.WriteString(fmt.Sprintf("oifname \"%s\" ct state established,related ip saddr %s %s sport %d-%d ip daddr %s accept; ", link.HostInterface, address.String(), rule.Protocol, rule.PortStart, rule.PortEnd, environment.TunnelIPv4CIDR))
	}
	namespaceFirewall := fmt.Sprintf("table inet nexo_env {\n chain input { type filter hook input priority 0; policy drop; iifname \"lo\" accept; ct state established,related accept; iifname \"%s\" udp dport %d accept; }\n chain forward { type filter hook forward priority 0; policy drop; %s%s iifname \"tun0\" oifname \"%s\" ip saddr %s counter drop; }\n chain output { type filter hook output priority 0; policy drop; oifname \"lo\" accept; ct state established,related accept; ip daddr 169.254.169.254 drop; oifname \"%s\" udp sport %d accept; }\n}\n", link.NamespaceInterface, environment.ListenerPort, forwardRules.String(), returnRules.String(), link.NamespaceInterface, environment.TunnelIPv4CIDR, link.NamespaceInterface, environment.ListenerPort)
	hostFirewall := fmt.Sprintf("table inet %s {\n chain prerouting { type nat hook prerouting priority dstnat; policy accept; fib daddr type local udp dport %d dnat ip to %s:%d; }\n chain forward { type filter hook forward priority filter; policy accept; %s%s oifname \"%s\" ip daddr %s udp dport %d accept; iifname \"%s\" ip saddr %s udp sport %d accept; iifname \"%s\" counter drop; oifname \"%s\" counter drop; }\n}\n", tableName(environment), environment.ListenerPort, link.NamespaceAddress, environment.ListenerPort, hostReturnRules.String(), hostAccessRules.String(), link.HostInterface, link.NamespaceAddress, environment.ListenerPort, link.HostInterface, link.NamespaceAddress, environment.ListenerPort, link.HostInterface, link.HostInterface)
	unit := fmt.Sprintf("[Unit]\nDescription=NEXO OpenVPN environment %s\nAfter=network-online.target\n\n[Service]\nType=simple\nNetworkNamespacePath=/run/netns/%s\nExecStart=/usr/sbin/openvpn --config %s/openvpn.conf\nRestart=on-failure\nRestartSec=3s\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK\nCapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_SETUID CAP_SETGID CAP_SETPCAP\nAmbientCapabilities=\nDevicePolicy=closed\nDeviceAllow=/dev/net/tun rw\nMemoryMax=96M\nCPUQuota=25%%\nTasksMax=64\n\n", environment.ID, environment.NamespaceName, directory)
	canonical, _ := json.Marshal(environment)
	sum := sha256.New()
	for _, part := range [][]byte{canonical, []byte(openvpn), []byte(namespaceFirewall), []byte(hostFirewall), []byte(unit)} {
		sum.Write(part)
		sum.Write([]byte{0})
	}
	digest := hex.EncodeToString(sum.Sum(nil))
	return runtimeBundle{openvpn: openvpn, namespaceFirewall: namespaceFirewall, hostFirewall: hostFirewall, unit: unit, digest: digest}, nil
}

func netipPrefix(value string) (string, error) {
	_, network, err := net.ParseCIDR(value)
	if err != nil {
		return "", err
	}
	return network.IP.String(), nil
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
