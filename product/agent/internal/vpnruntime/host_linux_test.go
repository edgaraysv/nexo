//go:build linux

package vpnruntime

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeRendererContainsOnlyFixedOpenVPNFirewallAndUnitDirectives(t *testing.T) {
	host := &NativeHost{root: "/var/lib/nexo-node/environments", units: "/run/systemd/system"}
	environment := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	bundle, err := host.render(environment, linkFor(environment.ID))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"redirect-gateway", "client-to-client", "0.0.0.0/0", "::/0", "/bin/sh", "curl", "169.254.169.254 accept"} {
		if strings.Contains(bundle.openvpn+bundle.namespaceFirewall+bundle.hostFirewall+bundle.unit, forbidden) {
			t.Fatalf("rendered forbidden value %q", forbidden)
		}
	}
	for _, required := range []string{"proto udp", "ip daddr 169.254.169.254 drop", "policy drop", "MemoryMax=96M", "CPUQuota=25%", "TasksMax=64", "NetworkNamespacePath=/run/netns/nexo-aaaaaaaaaaaa", "RestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK"} {
		if !strings.Contains(bundle.openvpn+bundle.namespaceFirewall+bundle.hostFirewall+bundle.unit, required) {
			t.Fatalf("missing %q", required)
		}
	}
	if len(bundle.digest) != 64 {
		t.Fatalf("bad digest %q", bundle.digest)
	}
}

func TestNativeRendererPushesOnlyExactF08ResourceAndFiltersByTuple(t *testing.T) {
	host := &NativeHost{root: "/var/lib/nexo-node/environments", units: "/run/systemd/system"}
	env := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	env.PrivateAccess = []PrivateAccessRule{{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18443, PortEnd: 18443}}
	bundle, err := host.render(env, linkFor(env.ID))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(bundle.openvpn, `push "route 10.240.0.78 255.255.255.255"`) {
		t.Fatalf("exact resource route was not pushed: %s", bundle.openvpn)
	}
	for _, want := range []string{`ct state established,related ip saddr 10.240.0.78 tcp sport 18443-18443 ip daddr 10.90.0.0/24 accept`, `iifname "tun0"`, `ip saddr 10.90.0.0/24 ip daddr 10.240.0.78 tcp dport 18443-18443 accept`} {
		if !strings.Contains(bundle.namespaceFirewall, want) {
			t.Fatalf("missing data-plane rule %q: %s", want, bundle.namespaceFirewall)
		}
	}
	if !strings.Contains(forwardChain(bundle.namespaceFirewall), `iifname "tun0" oifname "`+linkFor(env.ID).NamespaceInterface+`" ip saddr 10.90.0.0/24 counter drop`) {
		t.Fatal("default-deny rule has no counter for packet-level evidence")
	}
	for _, forbidden := range []string{"10.240.0.0/24", "0.0.0.0/0", "redirect-gateway"} {
		if strings.Contains(bundle.openvpn+bundle.namespaceFirewall, forbidden) {
			t.Fatalf("unexpected broad route/directive %q", forbidden)
		}
	}
	if strings.Contains(forwardChain(bundle.namespaceFirewall)+forwardChain(bundle.hostFirewall), "ct state established,related accept") {
		t.Fatal("generic established conntrack rule could preserve revoked access")
	}
}

func TestNativeRendererAppliesRenderedRulesToKernelWhenEnabled(t *testing.T) {
	if os.Getenv("NEXO_F08_NFT_INTEGRATION") != "1" {
		t.Skip("requires an isolated container with nftables privileges")
	}
	host := &NativeHost{root: "/var/lib/nexo-node/environments", units: "/run/systemd/system"}
	env := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	env.PrivateAccess = []PrivateAccessRule{{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18443, PortEnd: 18443}}
	bundle, err := host.render(env, linkFor(env.ID))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ name, rules string }{{"nexo_env", bundle.namespaceFirewall}, {tableName(env), bundle.hostFirewall}} {
		path := filepath.Join(t.TempDir(), item.name+".nft")
		if err = os.WriteFile(path, []byte(item.rules), 0600); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"-c", "-f", path}, {"-f", path}} {
			output, commandErr := exec.Command("nft", args...).CombinedOutput()
			if commandErr != nil {
				t.Fatalf("nft %v failed: %v: %s", args[:2], commandErr, output)
			}
		}
		tableName := item.name
		t.Cleanup(func() { _ = exec.Command("nft", "delete", "table", "inet", tableName).Run() })
		actual, commandErr := exec.Command("nft", "list", "table", "inet", item.name).CombinedOutput()
		if commandErr != nil || !nftRulesEqual(string(actual), item.rules) {
			t.Fatalf("applied nft table %s differs from renderer: %v: %s", item.name, commandErr, actual)
		}
	}
}

func TestPKIGenerationIsPrivateAndIdempotent(t *testing.T) {
	directory := t.TempDir()
	environment := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	if err := ensurePKI(directory, environment); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(directory, "server.key"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := (func() os.FileMode {
		info, _ := os.Stat(filepath.Join(directory, "server.key"))
		return info.Mode().Perm()
	})(); mode != 0600 {
		t.Fatalf("unexpected key mode %o", mode)
	}
	if err = ensurePKI(directory, environment); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(directory, "server.key"))
	if string(before) != string(after) {
		t.Fatal("idempotent reconcile rotated server key")
	}
	static, _ := os.ReadFile(filepath.Join(directory, "tls-crypt.key"))
	if !strings.HasPrefix(string(static), "-----BEGIN OpenVPN Static key V1-----") {
		t.Fatal("invalid static key")
	}
}

func TestPKICorruptionFailsClosedWithoutRotation(t *testing.T) {
	directory := t.TempDir()
	desired := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	if err := ensurePKI(directory, desired); err != nil {
		t.Fatal(err)
	}
	caBefore, err := os.ReadFile(filepath.Join(directory, "ca.key"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "server.key"), []byte("corrupt\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = ensurePKI(directory, desired); err == nil {
		t.Fatal("corrupt complete PKI was accepted")
	}
	caAfter, _ := os.ReadFile(filepath.Join(directory, "ca.key"))
	if string(caBefore) != string(caAfter) {
		t.Fatal("corrupt PKI triggered silent CA rotation")
	}
}

func TestExecRunnerRejectsNonAllowlistedCommand(t *testing.T) {
	if _, err := (execRunner{}).Run(nil, "sh", "-c", "id"); err == nil {
		t.Fatal("shell unexpectedly allowed")
	}
}

type statefulRunner struct {
	commands         []string
	namespace, table bool
	running          bool
	link             Link
	port             int
	hostLink         bool
	failFirewall     bool
	failTableDelete  bool
	failTableList    bool
	failLinkMove     bool
	failHealthOnce   bool
	driftRules       bool
	namespaceRules   string
	hostRules        string
	route            string
}

func (runner *statefulRunner) Run(input []byte, name string, arguments ...string) (string, error) {
	command := name + " " + strings.Join(arguments, " ")
	runner.commands = append(runner.commands, command)
	if name == "ip" && len(arguments) >= 4 && arguments[0] == "route" {
		switch arguments[1] {
		case "show":
			return runner.route, nil
		case "add":
			if runner.route != "" {
				return "", errors.New("route already exists")
			}
			runner.route = strings.Join(arguments[2:], " ")
		case "del":
			runner.route = ""
		}
	}
	if name == "nft" && len(arguments) >= 2 && arguments[0] == "list" && arguments[1] == "tables" {
		if runner.failTableList {
			return "", errors.New("injected nft list failure")
		}
		if runner.table {
			return "table inet nx_aaaaaaaaaaaa\n", nil
		}
		return "", nil
	}
	if name == "systemctl" && len(arguments) > 0 {
		switch arguments[0] {
		case "show":
			return "loaded\n", nil
		case "is-active":
			if !runner.running {
				return "", errors.New("inactive")
			}
		case "start":
			runner.running = true
		case "stop":
			runner.running = false
		}
	}
	if name == "ip" && len(arguments) >= 2 && arguments[0] == "netns" {
		switch arguments[1] {
		case "list":
			if runner.namespace {
				return "nexo-aaaaaaaaaaaa (id: 0)\n", nil
			}
			return "", nil
		case "add":
			runner.namespace = true
		case "delete":
			runner.namespace = false
		case "exec":
			if len(arguments) >= 5 && arguments[3] == "ss" {
				return "UNCONN 0 0 0.0.0.0:" + fmt.Sprint(runner.port) + " 0.0.0.0:*", nil
			}
			if len(arguments) >= 5 && arguments[3] == "nft" && arguments[4] == "-f" {
				runner.namespaceRules = string(input)
				return "", nil
			}
			if len(arguments) >= 7 && arguments[3] == "nft" && arguments[4] == "list" && runner.failHealthOnce {
				runner.failHealthOnce = false
				return "", errors.New("runtime missing")
			}
			if len(arguments) >= 7 && arguments[3] == "nft" && arguments[4] == "list" {
				if runner.driftRules {
					return runner.namespaceRules + "\nadd rule inet nexo_env input counter accept", nil
				}
				return runner.namespaceRules, nil
			}
		}
	}
	if name == "ip" && len(arguments) >= 2 && arguments[0] == "link" {
		if arguments[1] == "add" {
			runner.hostLink = true
		}
		if arguments[1] == "set" && runner.failLinkMove {
			runner.failLinkMove = false
			return "", errors.New("injected link move failure")
		}
		if arguments[1] == "show" && !runner.hostLink {
			return "", ErrResourceNotFound
		}
		if arguments[1] == "delete" {
			runner.hostLink = false
		}
	}
	if name == "ip" && len(arguments) >= 6 && arguments[0] == "-n" && arguments[2] == "addr" && arguments[3] == "show" {
		return runner.link.NamespaceAddress, nil
	}
	if name == "ip" && len(arguments) >= 4 && arguments[0] == "addr" && arguments[1] == "show" {
		return runner.link.HostAddress, nil
	}
	if name == "nft" && len(arguments) > 0 {
		if arguments[0] == "list" {
			if !runner.table {
				return "", errors.New("table missing")
			}
			name := "nx_aaaaaaaaaaaa"
			if runner.driftRules {
				return runner.hostRules + "\nadd rule inet " + name + " forward counter accept", nil
			}
			return runner.hostRules, nil
		}
		if arguments[0] == "delete" {
			if runner.failTableDelete {
				runner.failTableDelete = false
				return "", errors.New("injected table cleanup failure")
			}
			runner.table = false
		}
		if arguments[0] == "-f" {
			if runner.failFirewall {
				runner.failFirewall = false
				return "", errors.New("injected firewall failure")
			}
			runner.table = true
			runner.hostRules = string(input)
		}
	}
	return "", nil
}

func TestNativeHostCleanupFailsClosedWhenHostFirewallCannotBeInspected(t *testing.T) {
	runner := &statefulRunner{failTableList: true}
	host, desired := nativeHostFixture(t, runner)
	if err := host.cleanupRuntime(desired); err == nil {
		t.Fatal("firewall inspection failure was ignored during cleanup")
	}
}

func nativeHostFixture(t *testing.T, runner *statefulRunner) (*NativeHost, DesiredEnvironment) {
	t.Helper()
	root, units := filepath.Join(t.TempDir(), "environments"), filepath.Join(t.TempDir(), "units")
	forwarding := filepath.Join(t.TempDir(), "ip_forward")
	if err := os.WriteFile(forwarding, []byte("1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	desired := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	runner.link, runner.port = linkFor(desired.ID), desired.ListenerPort
	return &NativeHost{root: root, units: units, forwardingPath: forwarding, runner: runner}, desired
}

func TestNativeHostCleansInterruptedProvisionAndRetries(t *testing.T) {
	runner := &statefulRunner{failFirewall: true}
	host, desired := nativeHostFixture(t, runner)
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err == nil {
		t.Fatal("injected provisioning failure was ignored")
	}
	if runner.namespace || runner.table || runner.running {
		t.Fatalf("partial runtime survived: %#v", runner)
	}
	keyBefore, err := os.ReadFile(filepath.Join(host.root, desired.ID, "pki", "server.key"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = host.Ensure(desired, linkFor(desired.ID)); err != nil {
		t.Fatal(err)
	}
	keyAfter, _ := os.ReadFile(filepath.Join(host.root, desired.ID, "pki", "server.key"))
	if string(keyBefore) != string(keyAfter) {
		t.Fatal("retry unexpectedly rotated persistent PKI")
	}
}

func TestNativeHostRebuildsEphemeralRuntimeAfterHostRestart(t *testing.T) {
	runner := &statefulRunner{}
	host, desired := nativeHostFixture(t, runner)
	first, err := host.Ensure(desired, linkFor(desired.ID))
	if err != nil {
		t.Fatal(err)
	}
	runner.namespace, runner.table, runner.running = false, false, false
	runner.failHealthOnce = true
	second, err := host.Ensure(desired, linkFor(desired.ID))
	if err != nil {
		t.Fatal(err)
	}
	if first != second || !runner.namespace || !runner.table || !runner.running {
		t.Fatalf("runtime was not reconstructed: %#v", runner)
	}
	adds := 0
	for _, command := range runner.commands {
		if strings.HasPrefix(command, "ip netns add ") {
			adds++
		}
	}
	if adds != 2 {
		t.Fatalf("expected two namespace creations, got %d", adds)
	}
}

func TestNativeHostRemovesVethLeftBeforeNamespaceMove(t *testing.T) {
	runner := &statefulRunner{failLinkMove: true}
	host, desired := nativeHostFixture(t, runner)
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err == nil {
		t.Fatal("injected link move failure was ignored")
	}
	if runner.namespace || runner.hostLink {
		t.Fatalf("orphan network resources survived: %#v", runner)
	}
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err != nil {
		t.Fatal(err)
	}
}

func TestNativeHostDetectsLiveFirewallDrift(t *testing.T) {
	runner := &statefulRunner{}
	host, desired := nativeHostFixture(t, runner)
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err != nil {
		t.Fatal(err)
	}
	runner.driftRules = true
	bundle, err := host.render(desired, linkFor(desired.ID))
	if err != nil {
		t.Fatal(err)
	}
	if host.healthy(desired, bundle) {
		t.Fatal("additional firewall rules were accepted as healthy")
	}
}

func TestNativeHostDoesNotReplaceForeignRouteAndCleansOwnedRouteWhenPermissionRevoked(t *testing.T) {
	runner := &statefulRunner{route: "10.90.0.0/24 via 100.127.1.2 dev eth0"}
	host, desired := nativeHostFixture(t, runner)
	desired.PrivateAccess = []PrivateAccessRule{{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18443, PortEnd: 18443}}
	if _, err := host.Ensure(desired, linkFor(desired.ID)); !errors.Is(err, ErrRouteConflict) {
		t.Fatalf("foreign route was not rejected: %v", err)
	}
	if runner.route != "10.90.0.0/24 via 100.127.1.2 dev eth0" || runner.namespace || runner.table {
		t.Fatalf("foreign route/runtime was modified: %#v", runner)
	}
	runner.route = ""
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err != nil {
		t.Fatal(err)
	}
	if runner.route == "" {
		t.Fatal("owned tunnel return route was not installed")
	}
	desired.PrivateAccess = nil
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err != nil {
		t.Fatal(err)
	}
	if runner.route != "" {
		t.Fatalf("revoked access left its return route installed: %q", runner.route)
	}
	bundle, err := host.render(desired, linkFor(desired.ID))
	if err != nil {
		t.Fatal(err)
	}
	forwardRules := forwardChain(bundle.namespaceFirewall) + forwardChain(bundle.hostFirewall)
	if strings.Contains(forwardRules, "10.240.0.78") || strings.Contains(forwardRules, "ct state established,related accept") {
		t.Fatal("revoked destination or generic conntrack allowance remains")
	}
}

func forwardChain(rules string) string {
	start := strings.Index(rules, "chain forward")
	if start < 0 {
		return ""
	}
	end := strings.Index(rules[start+len("chain forward"):], "\n chain ")
	if end < 0 {
		return rules[start:]
	}
	return rules[start : start+len("chain forward")+end]
}

func TestNativeHostSuspendRemovesOwnedReturnRoute(t *testing.T) {
	runner := &statefulRunner{}
	host, desired := nativeHostFixture(t, runner)
	desired.PrivateAccess = []PrivateAccessRule{{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18443, PortEnd: 18443}}
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err != nil {
		t.Fatal(err)
	}
	desired.DesiredState = "suspended"
	desired.PrivateAccess = nil
	if _, err := host.Suspend(desired); err != nil {
		t.Fatal(err)
	}
	if runner.route != "" || runner.namespace || runner.table || runner.running {
		t.Fatalf("suspend left network access active: %#v", runner)
	}
}

func TestNFTRulesEqualAllowsOnlyFormattingAndCanonicalPriorityDifferences(t *testing.T) {
	expected := "table inet x { chain input { type filter hook input priority 0; policy drop; iifname \"lo\" accept; } }"
	actual := "table inet x {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t\tiifname \"lo\" accept\n\t}\n}\n"
	if !nftRulesEqual(actual, expected) {
		t.Fatal("equivalent nftables output was rejected")
	}
	if nftRulesEqual(actual+"add rule inet x input counter accept", expected) {
		t.Fatal("additional nftables rule was accepted")
	}
	if !nftRulesEqual(`table inet x { chain forward { type filter hook forward priority filter; policy drop; iifname "tun0" counter packets 7 bytes 900 drop; } }`, `table inet x { chain forward { type filter hook forward priority filter; policy drop; iifname "tun0" counter drop; } }`) {
		t.Fatal("live counter values incorrectly made the rendered firewall unhealthy")
	}
}

func TestNativeHostCleanupContinuesAfterOneResourceFails(t *testing.T) {
	runner := &statefulRunner{}
	host, desired := nativeHostFixture(t, runner)
	if _, err := host.Ensure(desired, linkFor(desired.ID)); err != nil {
		t.Fatal(err)
	}
	runner.failTableDelete = true
	if err := host.cleanupRuntime(desired); err == nil {
		t.Fatal("cleanup failure was not reported")
	}
	if runner.namespace || runner.hostLink || runner.running {
		t.Fatalf("best-effort cleanup stopped too early: %#v", runner)
	}
}

func TestNativeHostInspectIsReadOnlyAndDetectsRevisionAndDrift(t *testing.T) {
	runner := &statefulRunner{}
	host, desired := nativeHostFixture(t, runner)
	digest, err := host.Ensure(desired, linkFor(desired.ID))
	if err != nil {
		t.Fatal(err)
	}
	before := len(runner.commands)
	current, clean, err := host.Inspect(desired, linkFor(desired.ID))
	if err != nil || !clean || current != digest {
		t.Fatalf("healthy environment not reported as applied: clean=%v digest=%q err=%v", clean, current, err)
	}
	for _, command := range runner.commands[before:] {
		for _, mutation := range []string{" add ", " start ", " stop ", " delete ", "-f"} {
			if strings.Contains(" "+command+" ", mutation) {
				t.Fatalf("inspection mutated native state: %q", command)
			}
		}
	}
	drifted := desired
	drifted.Revision = desired.Revision + 1
	if _, clean, err = host.Inspect(drifted, linkFor(drifted.ID)); err != nil || clean {
		t.Fatalf("revision change was reported healthy: clean=%v err=%v", clean, err)
	}
	runner.running = false
	if _, clean, err = host.Inspect(desired, linkFor(desired.ID)); err != nil || clean {
		t.Fatalf("stopped unit was reported healthy: clean=%v err=%v", clean, err)
	}
	if !runner.namespace {
		t.Fatal("inspection removed the namespace")
	}
}
