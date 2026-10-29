package main

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"

	"nexo.local/agent/internal/networkruntime"
)

// privateNetworkReport is the closed F08 observation payload. ProfileID stays
// in the URL; the API rejects any additional body field.
type privateNetworkReport struct {
	Revision      int64  `json:"revision"`
	ObservedState string `json:"observed_state"`
	ConfigDigest  string `json:"config_digest,omitempty"`
	ErrorCode     string `json:"error_code,omitempty"`
}

// observedNetworkHost is deliberately read-only. It reports a profile active
// only when its IPv4 destination routes already exist on this endpoint. It
// never changes routes, DNS or firewalls, so an unknown local state becomes an
// explicit error rather than a false "active".
type observedNetworkHost struct {
	hasRoute func(netip.Addr) (bool, error)
}

func (host *observedNetworkHost) Apply(plan networkruntime.ProfilePlan) error {
	if plan.Profile.PathMode != "direct" || plan.Profile.ReturnMode != "routed" {
		return networkruntime.NewHostError("profile_unsupported", errors.New("only direct routed profiles can be observed"))
	}
	if plan.Profile.DNSMode != "local" {
		return networkruntime.NewHostError("dns_observation_unsupported", errors.New("split DNS observation is not implemented"))
	}
	if len(plan.Resources) == 0 {
		return networkruntime.NewHostError("no_observable_resources", errors.New("profile has no IPv4 resources to verify"))
	}
	check := host.hasRoute
	if check == nil {
		check = hasIPv4Route
	}
	for _, resource := range plan.Resources {
		if resource.Kind != "ipv4" {
			return networkruntime.NewHostError("resource_observation_unsupported", errors.New("only IPv4 resources can be verified"))
		}
		address, err := netip.ParseAddr(resource.Address)
		if err != nil || !address.Is4() {
			return networkruntime.NewHostError("resource_observation_unsupported", errors.New("invalid IPv4 resource"))
		}
		observed, err := check(address)
		if err != nil {
			return networkruntime.NewHostError("route_observation_failed", err)
		}
		if !observed {
			return networkruntime.NewHostError("route_missing", fmt.Errorf("no local route to %s", address))
		}
	}
	return nil
}

func (host *observedNetworkHost) Remove(string, networkruntime.ProfilePlan) error {
	// This host is an observer, not an applier. There is no local state to
	// roll back; routes are owned by the VPN/runtime layer.
	return nil
}

func (service *serviceRuntime) syncPrivateNetworks() error {
	current, session, err := authenticateSession(service.base, service.dir, service.key)
	if err != nil || current.Audience != "endpoint" {
		return errors.New("endpoint authentication required")
	}
	token, ok := session["token"].(string)
	if !ok {
		return errors.New("missing device session")
	}
	var desired networkruntime.Desired
	if err = postWithToken(service.base, "/v1/device/private-network/reconcile", map[string]any{}, &desired, token); err != nil {
		return err
	}
	if len(desired.Profiles) > 64 || len(desired.Resources) > 512 || len(desired.Policies) > 4096 {
		return errors.New("private network catalog too large")
	}
	results := networkruntime.New(&observedNetworkHost{hasRoute: service.routeCheck}).Reconcile(desired)
	var failures []error
	for _, result := range results {
		report := privateNetworkReport{Revision: result.Revision, ObservedState: result.State}
		switch result.State {
		case "active":
			if len(result.Digest) != 64 {
				failures = append(failures, fmt.Errorf("profile %s has no valid digest", result.ProfileID))
				continue
			}
			report.ConfigDigest = result.Digest
		case "error":
			if result.ErrorCode == "" {
				failures = append(failures, fmt.Errorf("profile %s has no error code", result.ProfileID))
				continue
			}
			report.ErrorCode = result.ErrorCode
		default:
			failures = append(failures, fmt.Errorf("profile %s returned invalid state", result.ProfileID))
			continue
		}
		path := "/v1/device/private-network/" + url.PathEscape(result.ProfileID) + "/report"
		if err = postWithToken(service.base, path, report, nil, token); err != nil {
			failures = append(failures, fmt.Errorf("profile %s: %w", result.ProfileID, err))
		}
	}
	return errors.Join(failures...)
}
