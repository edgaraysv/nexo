package networkruntime

import (
	"errors"
	"testing"
)

const (
	profileID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
	tenantID  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
	siteID    = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"
	envID     = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"
)

type testHost struct {
	applied             map[string]ProfilePlan
	applyErr, removeErr error
	applyFailRevision   int64
	calls               []string
}

func (h *testHost) Apply(p ProfilePlan) error {
	h.calls = append(h.calls, "apply:"+p.Profile.ID)
	if h.applyErr != nil && (h.applyFailRevision == 0 || p.Profile.Revision == h.applyFailRevision) {
		return h.applyErr
	}
	if h.applied == nil {
		h.applied = map[string]ProfilePlan{}
	}
	h.applied[p.Profile.ID] = p
	return nil
}
func (h *testHost) Remove(id string, _ ProfilePlan) error {
	h.calls = append(h.calls, "remove:"+id)
	if h.removeErr != nil {
		return h.removeErr
	}
	delete(h.applied, id)
	return nil
}

func fixture() Desired {
	return Desired{Profiles: []Profile{{ID: profileID, TenantID: tenantID, SiteID: siteID, VPNEnvironmentID: envID, SiteNetworks: []string{"10.20.0.0/24"}, PathMode: "gateway", GatewayDeviceID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1", ReturnMode: "snat", DNSMode: "split", DNSServers: []string{"10.20.0.53"}, DNSSuffixes: []string{"corp.example"}, DesiredState: "active", Revision: 1}}, Resources: []Resource{{ID: "ffffffff-ffff-4fff-8fff-fffffffffff1", ProfileID: profileID, Kind: "ipv4", Address: "10.20.0.8", Status: "active", Revision: 1}, {ID: "11111111-1111-4111-8111-111111111111", ProfileID: profileID, Kind: "hostname", Address: "db.corp.example", Status: "active", Revision: 1}}, Policies: []Policy{{ID: "22222222-2222-4222-8222-222222222222", ProfileID: profileID, Effect: "allow", SourceKind: "any_endpoint", ResourceID: "ffffffff-ffff-4fff-8fff-fffffffffff1", Protocol: "tcp", PortStart: 5432, PortEnd: 5432, Status: "active", Revision: 1}}}
}

func TestReconcileAppliesPlanAndHonorsRevision(t *testing.T) {
	h := &testHost{}
	r := New(h)
	desired := fixture()
	result := r.Reconcile(desired)
	if len(result) != 1 || result[0].State != "active" || result[0].Digest == "" {
		t.Fatalf("apply failed: %+v", result)
	}
	if got := h.applied[profileID]; got.Profile.ReturnMode != "snat" || len(got.Resources) != 2 || len(got.Policies) != 1 {
		t.Fatalf("incomplete plan: %+v", got)
	}
	// Identical revision is idempotent; changed contents at the same revision fail closed.
	r.Reconcile(desired)
	if len(h.calls) != 1 {
		t.Fatalf("same revision reapplied: %v", h.calls)
	}
	desired.Profiles[0].DNSServers = []string{"10.20.0.54"}
	result = r.Reconcile(desired)
	if result[0].ErrorCode != "revision_conflict" {
		t.Fatalf("same revision mutation accepted: %+v", result)
	}
	desired.Profiles[0].Revision = 0 // unchanged below is invalid before stale check
	desired.Profiles[0].Revision = 2
	desired.Profiles[0].DNSServers = []string{"10.20.0.53"}
	result = r.Reconcile(desired)
	if result[0].State != "active" || len(h.calls) != 2 {
		t.Fatalf("new revision not applied: %+v %v", result, h.calls)
	}
}

func TestReconcileRemovesWithdrawnProfileAndReportsCleanupFailure(t *testing.T) {
	h := &testHost{}
	r := New(h)
	desired := fixture()
	r.Reconcile(desired)
	result := r.Reconcile(Desired{})
	if len(result) != 0 || len(h.applied) != 0 {
		t.Fatalf("withdrawn profile remains: %+v", h.applied)
	}
	r.Reconcile(desired)
	h.removeErr = errors.New("host detail")
	result = r.Reconcile(Desired{})
	if len(result) != 1 || result[0].ErrorCode != "cleanup_failed" || result[0].State != "error" {
		t.Fatalf("cleanup failure hidden: %+v", result)
	}
}

func TestReconcileCleansPartialApplyAndRejectsUnsafeContract(t *testing.T) {
	h := &testHost{applyErr: errors.New("secret OS failure")}
	r := New(h)
	result := r.Reconcile(fixture())
	if result[0].ErrorCode != "apply_failed" || result[0].State != "error" || len(h.applied) != 0 || len(h.calls) != 2 {
		t.Fatalf("partial apply not cleaned: %+v calls=%v", result, h.calls)
	}
	bad := fixture()
	bad.Profiles[0].SiteNetworks = []string{"0.0.0.0/0"}
	result = r.Reconcile(bad)
	if result[0].ErrorCode != "invalid_spec" || len(h.calls) != 2 {
		t.Fatalf("unsafe route reached host: %+v calls=%v", result, h.calls)
	}
}

func TestReconcileRestoresPreviousRevisionWhenApplyFails(t *testing.T) {
	h := &testHost{}
	r := New(h)
	d := fixture()
	if got := r.Reconcile(d); got[0].State != "active" {
		t.Fatalf("initial apply: %+v", got)
	}
	d.Profiles[0].Revision = 2
	d.Profiles[0].DNSServers = []string{"10.20.0.54"}
	h.applyErr = errors.New("partial native apply")
	h.applyFailRevision = 2
	got := r.Reconcile(d)
	if got[0].ErrorCode != "apply_failed" || h.applied[profileID].Profile.Revision != 1 {
		t.Fatalf("old revision not restored: result=%+v applied=%+v", got, h.applied[profileID])
	}
}

func TestBuildPlansRejectsUnscopedPolicyAndDNSOutsideSplitDomain(t *testing.T) {
	for _, mutate := range []func(*Desired){func(d *Desired) { d.Policies[0].ResourceID = "33333333-3333-4333-8333-333333333333" }, func(d *Desired) { d.Resources[1].Address = "db.attacker.example" }, func(d *Desired) {
		d.Profiles[0].PathMode = "direct"
		d.Profiles[0].GatewayDeviceID = ""
		d.Profiles[0].ReturnMode = "snat"
	}} {
		d := fixture()
		mutate(&d)
		if _, err := buildPlans(d); err == nil {
			t.Fatal("unsafe desired state accepted")
		}
	}
}
