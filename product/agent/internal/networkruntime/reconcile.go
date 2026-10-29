// Package networkruntime validates and reconciles the authenticated F08
// desired-state document. Platform hosts are deliberately behind Host so the
// planner never claims that a policy is applied merely because it parsed.
package networkruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"
)

type Desired struct {
	Profiles  []Profile  `json:"profiles"`
	Resources []Resource `json:"resources"`
	Policies  []Policy   `json:"policies"`
}

type Profile struct {
	ID               string   `json:"id"`
	TenantID         string   `json:"tenantId"`
	SiteID           string   `json:"siteId"`
	VPNEnvironmentID string   `json:"vpnEnvironmentId"`
	SiteNetworks     []string `json:"siteNetworks"`
	PathMode         string   `json:"pathMode"`
	GatewayDeviceID  string   `json:"gatewayDeviceId,omitempty"`
	ReturnMode       string   `json:"returnMode"`
	DNSMode          string   `json:"dnsMode"`
	DNSServers       []string `json:"dnsServers"`
	DNSSuffixes      []string `json:"dnsSuffixes"`
	DesiredState     string   `json:"desiredState"`
	Revision         int64    `json:"revision"`
}

type Resource struct {
	ID        string `json:"id"`
	ProfileID string `json:"profileId"`
	Kind      string `json:"kind"`
	Address   string `json:"address"`
	Status    string `json:"status"`
	Revision  int64  `json:"revision"`
}

type Policy struct {
	ID             string `json:"id"`
	ProfileID      string `json:"profileId"`
	Effect         string `json:"effect"`
	SourceKind     string `json:"sourceKind"`
	SourceDeviceID string `json:"sourceDeviceId,omitempty"`
	ResourceID     string `json:"resourceId"`
	Protocol       string `json:"protocol"`
	PortStart      int    `json:"portStart"`
	PortEnd        int    `json:"portEnd"`
	Status         string `json:"status"`
	Revision       int64  `json:"revision"`
}

// ProfilePlan is the complete NEXO-owned state for one profile. A Host must
// apply it transactionally or return an error and remove any partial effects.
type ProfilePlan struct {
	Profile   Profile    `json:"profile"`
	Resources []Resource `json:"resources"`
	Policies  []Policy   `json:"policies"`
	Digest    string     `json:"digest"`
}

type Result struct {
	ProfileID string `json:"profile_id"`
	Revision  int64  `json:"revision"`
	State     string `json:"observed_state"`
	Digest    string `json:"config_digest,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
}

type Host interface {
	Apply(ProfilePlan) error
	Remove(profileID string, previous ProfilePlan) error
}

// HostError lets a platform host distinguish an unsupported or unverified
// local state from a generic apply failure. The code is reported to the API.
type HostError struct {
	Code string
	Err  error
}

func (e *HostError) Error() string {
	if e.Err == nil {
		return e.Code
	}
	return e.Code + ": " + e.Err.Error()
}

func (e *HostError) Unwrap() error { return e.Err }

func NewHostError(code string, err error) *HostError { return &HostError{Code: code, Err: err} }

func hostErrorCode(err error) string {
	var hostError *HostError
	if errors.As(err, &hostError) && hostError.Code != "" {
		return hostError.Code
	}
	return "apply_failed"
}

type Reconciler struct {
	host    Host
	applied map[string]ProfilePlan
}

func New(host Host) *Reconciler { return &Reconciler{host: host, applied: map[string]ProfilePlan{}} }

func (r *Reconciler) Reconcile(desired Desired) []Result {
	plans, err := buildPlans(desired)
	if err != nil {
		return invalidResults(desired.Profiles, "invalid_spec")
	}
	ids := make([]string, 0, len(plans))
	for id := range plans {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	results := make([]Result, 0, len(plans)+len(r.applied))
	for id, old := range r.applied {
		if _, exists := plans[id]; exists {
			continue
		}
		if err := r.host.Remove(id, old); err != nil {
			results = append(results, Result{ProfileID: id, Revision: old.Profile.Revision, State: "error", ErrorCode: "cleanup_failed"})
			continue
		}
		delete(r.applied, id)
	}
	for _, id := range ids {
		plan := plans[id]
		old, exists := r.applied[id]
		if exists {
			if plan.Profile.Revision < old.Profile.Revision {
				results = append(results, Result{ProfileID: id, Revision: plan.Profile.Revision, State: "error", ErrorCode: "stale_revision"})
				continue
			}
			if plan.Profile.Revision == old.Profile.Revision {
				if plan.Digest != old.Digest {
					results = append(results, Result{ProfileID: id, Revision: plan.Profile.Revision, State: "error", ErrorCode: "revision_conflict"})
					continue
				}
				results = append(results, Result{ProfileID: id, Revision: plan.Profile.Revision, State: "active", Digest: plan.Digest})
				continue
			}
		}
		if err := r.host.Apply(plan); err != nil {
			cleanupErr := r.host.Remove(id, plan)
			code := hostErrorCode(err)
			if cleanupErr != nil {
				code = "partial_apply_cleanup_failed"
			}
			if exists && cleanupErr == nil {
				if restoreErr := r.host.Apply(old); restoreErr != nil {
					_ = r.host.Remove(id, old)
					delete(r.applied, id)
					code = "rollback_failed"
				} else {
					r.applied[id] = old
				}
			}
			results = append(results, Result{ProfileID: id, Revision: plan.Profile.Revision, State: "error", ErrorCode: code})
			continue
		}
		r.applied[id] = plan
		results = append(results, Result{ProfileID: id, Revision: plan.Profile.Revision, State: "active", Digest: plan.Digest})
	}
	return results
}

func invalidResults(profiles []Profile, code string) []Result {
	out := make([]Result, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, Result{ProfileID: p.ID, Revision: p.Revision, State: "error", ErrorCode: code})
	}
	return out
}

func buildPlans(desired Desired) (map[string]ProfilePlan, error) {
	profiles := map[string]Profile{}
	for _, p := range desired.Profiles {
		if !validID(p.ID) || p.Revision < 1 || p.DesiredState != "active" || !validID(p.TenantID) || !validID(p.SiteID) || !validID(p.VPNEnvironmentID) {
			return nil, errors.New("invalid profile")
		}
		if _, ok := profiles[p.ID]; ok {
			return nil, errors.New("duplicate profile")
		}
		if p.PathMode != "direct" && p.PathMode != "gateway" || p.ReturnMode != "routed" && p.ReturnMode != "snat" || p.DNSMode != "local" && p.DNSMode != "split" {
			return nil, errors.New("invalid profile mode")
		}
		if p.PathMode == "direct" && (p.GatewayDeviceID != "" || p.ReturnMode != "routed") || p.PathMode == "gateway" && !validID(p.GatewayDeviceID) {
			return nil, errors.New("invalid profile path")
		}
		if len(p.SiteNetworks) == 0 || len(p.SiteNetworks) > 16 {
			return nil, errors.New("invalid site networks")
		}
		parsedNetworks := make([]netip.Prefix, 0, len(p.SiteNetworks))
		for _, s := range p.SiteNetworks {
			prefix, e := netip.ParsePrefix(s)
			if e != nil || prefix != prefix.Masked() || !prefix.Addr().IsPrivate() || prefix.Addr().Is4In6() || prefix.Addr().Is4() && prefix.Bits() < 16 || prefix.Addr().Is6() && prefix.Bits() < 48 {
				return nil, errors.New("unsafe site route")
			}
			for _, previous := range parsedNetworks {
				if previous.Overlaps(prefix) {
					return nil, errors.New("overlapping site routes")
				}
			}
			parsedNetworks = append(parsedNetworks, prefix)
		}
		if p.DNSMode == "local" && (len(p.DNSServers) != 0 || len(p.DNSSuffixes) != 0) || p.DNSMode == "split" && (len(p.DNSServers) == 0 || len(p.DNSServers) > 4 || len(p.DNSSuffixes) == 0 || len(p.DNSSuffixes) > 8) {
			return nil, errors.New("invalid split dns")
		}
		for _, server := range p.DNSServers {
			a, e := netip.ParseAddr(server)
			if e != nil || !a.IsPrivate() {
				return nil, errors.New("unsafe dns server")
			}
		}
		for _, suffix := range p.DNSSuffixes {
			if !validSuffix(suffix) {
				return nil, errors.New("invalid dns suffix")
			}
		}
		profiles[p.ID] = p
	}
	resources := map[string]Resource{}
	for _, v := range desired.Resources {
		p, ok := profiles[v.ProfileID]
		if !ok || !validID(v.ID) || v.Status != "active" || v.Revision < 1 || v.Kind != "ipv4" && v.Kind != "hostname" {
			return nil, errors.New("invalid resource")
		}
		if _, ok = resources[v.ID]; ok {
			return nil, errors.New("duplicate resource")
		}
		if v.Kind == "ipv4" {
			a, e := netip.ParseAddr(v.Address)
			if e != nil || !a.Is4() || !a.IsPrivate() || !prefixContains(p.SiteNetworks, a) {
				return nil, errors.New("resource outside site")
			}
		} else if !validSuffix(v.Address) || p.DNSMode != "split" || !matchesSuffix(v.Address, p.DNSSuffixes) {
			return nil, errors.New("invalid hostname resource")
		}
		resources[v.ID] = v
	}
	policies := map[string][]Policy{}
	seen := map[string]bool{}
	for _, v := range desired.Policies {
		p, ok := profiles[v.ProfileID]
		res, resourceOK := resources[v.ResourceID]
		if !ok || !resourceOK || res.ProfileID != v.ProfileID || !validID(v.ID) || v.Status != "active" || v.Revision < 1 || seen[v.ID] || v.Effect != "allow" && v.Effect != "deny" || v.Protocol != "tcp" && v.Protocol != "udp" || v.PortStart < 1 || v.PortEnd < v.PortStart || v.PortEnd > 65535 {
			return nil, errors.New("invalid policy")
		}
		if v.SourceKind != "any_endpoint" && v.SourceKind != "device" || v.SourceKind == "any_endpoint" && v.SourceDeviceID != "" || v.SourceKind == "device" && !validID(v.SourceDeviceID) {
			return nil, errors.New("invalid policy source")
		}
		if p.PathMode == "direct" && v.SourceKind == "device" && v.SourceDeviceID != "" { /* the authenticated endpoint filter is enforced by the API */
		}
		seen[v.ID] = true
		policies[v.ProfileID] = append(policies[v.ProfileID], v)
	}
	plans := map[string]ProfilePlan{}
	for id, p := range profiles {
		plan := ProfilePlan{Profile: p}
		for _, v := range resources {
			if v.ProfileID == id {
				plan.Resources = append(plan.Resources, v)
			}
		}
		plan.Policies = policies[id]
		sort.Slice(plan.Resources, func(i, j int) bool { return plan.Resources[i].ID < plan.Resources[j].ID })
		sort.Slice(plan.Policies, func(i, j int) bool { return plan.Policies[i].ID < plan.Policies[j].ID })
		canonical, e := json.Marshal(plan)
		if e != nil {
			return nil, e
		}
		sum := sha256.Sum256(canonical)
		plan.Digest = hex.EncodeToString(sum[:])
		plans[id] = plan
	}
	return plans, nil
}

func validID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if i == 14 && c != '4' || i == 19 && c != '8' && c != '9' && c != 'a' && c != 'b' {
			return false
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func validSuffix(s string) bool {
	if len(s) > 253 || strings.TrimSpace(s) != s {
		return false
	}
	labels := strings.Split(strings.ToLower(s), ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if len(l) < 1 || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for _, c := range l {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}
func matchesSuffix(host string, suffixes []string) bool {
	host = strings.ToLower(host)
	for _, s := range suffixes {
		if host == strings.ToLower(s) || strings.HasSuffix(host, "."+strings.ToLower(s)) {
			return true
		}
	}
	return false
}
func prefixContains(networks []string, address netip.Addr) bool {
	for _, s := range networks {
		p, e := netip.ParsePrefix(s)
		if e == nil && p.Contains(address) {
			return true
		}
	}
	return false
}
func (p ProfilePlan) String() string {
	return fmt.Sprintf("profile=%s revision=%d digest=%s", p.Profile.ID, p.Profile.Revision, p.Digest)
}
