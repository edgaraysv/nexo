package vpnruntime

import (
	"errors"
	"testing"
)

type fakeHost struct {
	active, suspended, retired []string
	known                      map[string]struct{}
	err                        error
	clean                      bool
	inspectErr                 error
}

func (f *fakeHost) Inspect(e DesiredEnvironment, _ Link) (string, bool, error) {
	if f.inspectErr != nil {
		return "", false, f.inspectErr
	}
	return digest(e.ID), f.clean, nil
}
func (f *fakeHost) Ensure(e DesiredEnvironment, _ Link) (string, error) {
	f.active = append(f.active, e.ID)
	return digest(e.ID), f.err
}
func (f *fakeHost) Suspend(e DesiredEnvironment) (string, error) {
	f.suspended = append(f.suspended, e.ID)
	return digest(e.ID), f.err
}
func (f *fakeHost) Retire(e DesiredEnvironment) (string, error) {
	f.retired = append(f.retired, e.ID)
	return digest(e.ID), f.err
}
func (f *fakeHost) CleanupUnknown(known map[string]struct{}) error { f.known = known; return nil }
func digest(seed string) string {
	const hex = "0123456789abcdef"
	out := make([]byte, 64)
	for i := range out {
		out[i] = hex[(i+len(seed))%len(hex)]
	}
	return string(out)
}

func environment(id, state string, port int) DesiredEnvironment {
	return DesiredEnvironment{ID: id, Engine: "openvpn", Protocol: "udp", ListenerPort: port, TunnelIPv4CIDR: "10.90.0.0/24", NamespaceName: "nexo-" + id[:8] + id[9:13], DesiredState: state, Revision: 1}
}

func TestReconcileAppliesClosedLifecycleAndOverlappingTenantCIDR(t *testing.T) {
	host := &fakeHost{}
	items := []DesiredEnvironment{
		environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194),
		environment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6", "active", 21195),
		environment("cccccccc-cccc-4ccc-8ccc-ccccccccccc6", "suspended", 21196),
		environment("dddddddd-dddd-4ddd-8ddd-ddddddddddd6", "retired", 21197),
	}
	results := New(host).Reconcile(items, nil)
	if len(results) != 4 || len(host.active) != 2 || len(host.suspended) != 1 || len(host.retired) != 1 {
		t.Fatalf("unexpected lifecycle: %#v", results)
	}
	if len(host.known) != 4 {
		t.Fatalf("unexpected desired set: %#v", host.known)
	}
	if linkFor(items[0].ID).Prefix == linkFor(items[1].ID).Prefix {
		t.Fatal("fixture unexpectedly collided")
	}
}

func TestReconcileRejectsArbitraryOrUnsafeSpecification(t *testing.T) {
	for _, mutate := range []func(*DesiredEnvironment){
		func(e *DesiredEnvironment) { e.Engine = "wireguard" }, func(e *DesiredEnvironment) { e.Protocol = "tcp" },
		func(e *DesiredEnvironment) { e.TunnelIPv4CIDR = "0.0.0.0/0" }, func(e *DesiredEnvironment) { e.NamespaceName = "../../host" },
		func(e *DesiredEnvironment) { e.DesiredState = "shell" }, func(e *DesiredEnvironment) { e.IPv6Enabled = true },
	} {
		host := &fakeHost{}
		item := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
		mutate(&item)
		result := New(host).Reconcile([]DesiredEnvironment{item}, nil)[0]
		if result.ErrorCode != "invalid_spec" || len(host.active) != 0 {
			t.Fatalf("unsafe item accepted: %#v", item)
		}
	}
}

func TestPrivateAccessAcceptsOnlyExactPrivateDestinationTuples(t *testing.T) {
	item := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	item.PrivateAccess = []PrivateAccessRule{{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18443, PortEnd: 18443}}
	if err := validate(item); err != nil {
		t.Fatalf("valid exact rule rejected: %v", err)
	}
	for _, rule := range []PrivateAccessRule{
		{Address: "0.0.0.0", Protocol: "tcp", PortStart: 18443, PortEnd: 18443},
		{Address: "10.240.0.78/24", Protocol: "tcp", PortStart: 18443, PortEnd: 18443},
		{Address: "10.240.0.78", Protocol: "all", PortStart: 1, PortEnd: 65535},
		{Address: "10.240.0.78", Protocol: "tcp", PortStart: 0, PortEnd: 18443},
	} {
		bad := item
		bad.PrivateAccess = []PrivateAccessRule{rule}
		if err := validate(bad); err == nil {
			t.Fatalf("unsafe rule accepted: %+v", rule)
		}
	}
	bad := item
	bad.PrivateAccess = []PrivateAccessRule{
		{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18440, PortEnd: 18450},
		{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18445, PortEnd: 18455},
	}
	if err := validate(bad); err == nil {
		t.Fatal("overlapping rules for one service were accepted")
	}
}

func TestReconcileRejectsOverlappingTunnelRoutesForPrivateAccess(t *testing.T) {
	host := &fakeHost{}
	first := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	second := environment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6", "active", 21195)
	first.PrivateAccess = []PrivateAccessRule{{Address: "10.240.0.78", Protocol: "tcp", PortStart: 18443, PortEnd: 18443}}
	second.PrivateAccess = append([]PrivateAccessRule(nil), first.PrivateAccess...)
	results := New(host).Reconcile([]DesiredEnvironment{first, second}, nil)
	if len(host.active) != 0 || len(results) != 2 || results[0].ErrorCode != "transit_collision" || results[1].ErrorCode != "transit_collision" {
		t.Fatalf("overlapping VPN return routes were not rejected: %#v", results)
	}
}

func TestReconcileMapsHostErrorsToAllowlistedCodes(t *testing.T) {
	host := &fakeHost{err: ErrForwardingDisabled}
	result := New(host).Reconcile([]DesiredEnvironment{environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)}, nil)[0]
	if result.ErrorCode != "forwarding_disabled" {
		t.Fatalf("unexpected code: %#v", result)
	}
	host.err = errors.New("secret host detail")
	result = New(host).Reconcile([]DesiredEnvironment{environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)}, nil)[0]
	if result.ErrorCode != "runtime_apply_failed" {
		t.Fatalf("unexpected code: %#v", result)
	}
}

func TestReconcileRejectsDuplicateActivePortsBeforeHostMutation(t *testing.T) {
	host := &fakeHost{}
	first := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	second := environment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6", "active", 21194)
	results := New(host).Reconcile([]DesiredEnvironment{first, second}, nil)
	if len(host.active) != 0 || len(results) != 2 || results[0].ErrorCode != "port_collision" || results[1].ErrorCode != "port_collision" {
		t.Fatalf("duplicate port was not rejected atomically: %#v", results)
	}
}

func TestReconcileHealthyEnvironmentDoesNotPublishProvisioning(t *testing.T) {
	host := &fakeHost{clean: true}
	item := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	var published []Result
	results := New(host).Reconcile([]DesiredEnvironment{item}, func(result Result) error {
		published = append(published, result)
		return nil
	})
	if len(published) != 0 {
		t.Fatalf("healthy environment published a transition: %#v", published)
	}
	if len(host.active) != 0 {
		t.Fatalf("healthy environment was re-applied: %#v", host.active)
	}
	if len(results) != 1 || results[0].ObservedState != "active" || results[0].ErrorCode != "" {
		t.Fatalf("unexpected result: %#v", results)
	}
}

func TestReconcileRealRepairPublishesProvisioningBeforeApplying(t *testing.T) {
	host := &fakeHost{clean: false}
	item := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	var order []string
	results := New(host).Reconcile([]DesiredEnvironment{item}, func(result Result) error {
		if result.ID != item.ID || result.Revision != item.Revision || result.ObservedState != "provisioning" {
			t.Fatalf("unexpected progress report: %#v", result)
		}
		order = append(order, "provisioning")
		return nil
	})
	order = append(order, host.active...)
	if len(order) != 2 || order[0] != "provisioning" || order[1] != item.ID {
		t.Fatalf("provisioning was not published before the repair: %#v", order)
	}
	if len(results) != 1 || results[0].ObservedState != "active" {
		t.Fatalf("repair did not converge to active: %#v", results)
	}
}

func TestReconcileInspectionFailureIsNotTreatedAsHealthy(t *testing.T) {
	host := &fakeHost{inspectErr: errors.New("probe failed")}
	item := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	published := 0
	result := New(host).Reconcile([]DesiredEnvironment{item}, func(Result) error { published++; return nil })[0]
	if result.ErrorCode != "runtime_inspect_failed" || len(host.active) != 0 || published != 0 {
		t.Fatalf("inspection failure was treated as actionable or healthy: %#v", result)
	}
}

func TestReconcileReportFailureDoesNotInterruptOtherEnvironments(t *testing.T) {
	host := &fakeHost{}
	first := environment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "active", 21194)
	second := environment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6", "active", 21195)
	results := New(host).Reconcile([]DesiredEnvironment{first, second}, func(result Result) error {
		if result.ID == first.ID {
			return errors.New("control unavailable")
		}
		return nil
	})
	if len(results) != 2 || results[0].ErrorCode != "runtime_report_failed" || results[1].ObservedState != "active" {
		t.Fatalf("report failure interrupted reconciliation: %#v", results)
	}
	if len(host.active) != 1 || host.active[0] != second.ID {
		t.Fatalf("second environment was not reconciled: %#v", host.active)
	}
}
