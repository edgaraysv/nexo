package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"nexo.local/agent/internal/networkruntime"
)

const (
	networkProfileID  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
	networkTenantID   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
	networkSiteID     = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"
	networkVPNID      = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"
	networkResourceID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1"
	networkPolicyID   = "ffffffff-ffff-4fff-8fff-fffffffffff1"
)

func networkDesired() networkruntime.Desired {
	return networkruntime.Desired{
		Profiles: []networkruntime.Profile{{
			ID: networkProfileID, TenantID: networkTenantID, SiteID: networkSiteID, VPNEnvironmentID: networkVPNID,
			SiteNetworks: []string{"10.20.0.0/24"}, PathMode: "direct", ReturnMode: "routed", DNSMode: "local",
			DesiredState: "active", Revision: 7,
		}},
		Resources: []networkruntime.Resource{{ID: networkResourceID, ProfileID: networkProfileID, Kind: "ipv4", Address: "10.20.0.8", Status: "active", Revision: 7}},
		Policies:  []networkruntime.Policy{{ID: networkPolicyID, ProfileID: networkProfileID, Effect: "allow", SourceKind: "any_endpoint", ResourceID: networkResourceID, Protocol: "tcp", PortStart: 5432, PortEnd: 5432, Status: "active", Revision: 7}},
	}
}

func TestParseWindowsIPv4Routes(t *testing.T) {
	output := `IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      10.0.0.1       10.0.0.5      25
     10.240.0.250  255.255.255.255      10.247.34.1     10.247.34.2      1
      10.20.0.0    255.255.255.0      10.247.34.1     10.247.34.2      1
      10.20.1.0    255.255.0.255      10.247.34.1     10.247.34.2      1
`
	routes := parseWindowsIPv4Routes(output)
	if len(routes) != 3 {
		t.Fatalf("unexpected route count: %d (%v)", len(routes), routes)
	}
	for address, want := range map[string]bool{
		"10.240.0.250": true,
		"10.20.0.8":    true,
		"10.20.2.8":    false,
		"10.30.0.8":    false,
		"192.168.1.1":  false,
	} {
		parsed := netip.MustParseAddr(address)
		if got := containsIPv4Route(routes, parsed); got != want {
			t.Fatalf("route lookup for %s = %v, want %v", address, got, want)
		}
	}
}

func TestPrivateNetworkObservationReportsOnlyVerifiedState(t *testing.T) {
	desired := networkDesired()
	reports := []privateNetworkReport{}
	reportPaths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch {
		case request.URL.Path == "/v1/device-auth/challenge":
			json.NewEncoder(response).Encode(map[string]string{"challenge": "challenge"})
		case request.URL.Path == "/v1/device-auth/verify":
			json.NewEncoder(response).Encode(map[string]string{"token": "device-token"})
		case request.URL.Path == "/v1/device/private-network/reconcile":
			if request.Header.Get("authorization") != "Bearer device-token" {
				t.Error("private network reconcile was not authenticated")
			}
			json.NewEncoder(response).Encode(desired)
		case strings.HasPrefix(request.URL.Path, "/v1/device/private-network/") && strings.HasSuffix(request.URL.Path, "/report"):
			var report privateNetworkReport
			if err := json.NewDecoder(request.Body).Decode(&report); err != nil {
				t.Errorf("invalid report: %v", err)
			}
			if request.Header.Get("authorization") != "Bearer device-token" {
				t.Error("private network report was not authenticated")
			}
			reports = append(reports, report)
			reportPaths = append(reportPaths, request.URL.Path)
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service := &serviceRuntime{base: server.URL, dir: dir, key: key, routeCheck: func(address netip.Addr) (bool, error) {
		return address == netip.MustParseAddr("10.20.0.8"), nil
	}}
	if err = writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	if err = service.syncPrivateNetworks(); err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].ObservedState != "active" || reports[0].Revision != 7 || len(reports[0].ConfigDigest) != 64 || reports[0].ErrorCode != "" {
		t.Fatalf("unexpected active report: %#v", reports)
	}
	if reportPaths[0] != "/v1/device/private-network/"+networkProfileID+"/report" {
		t.Fatalf("unexpected report path: %q", reportPaths[0])
	}
	if strings.Contains(string(mustJSON(reports[0])), "profile_id") {
		t.Fatal("report body leaked the profile id field")
	}

	// The same desired state with no matching route must report an explicit
	// error; it must never be promoted to active by parsing alone.
	reports = reports[:0]
	service.routeCheck = func(netip.Addr) (bool, error) { return false, nil }
	if err = service.syncPrivateNetworks(); err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].ObservedState != "error" || reports[0].ErrorCode != "route_missing" || reports[0].ConfigDigest != "" {
		t.Fatalf("unexpected missing-route report: %#v", reports)
	}

	reports = reports[:0]
	service.routeCheck = func(netip.Addr) (bool, error) { return false, errors.New("route table unavailable") }
	if err = service.syncPrivateNetworks(); err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].ObservedState != "error" || reports[0].ErrorCode != "route_observation_failed" {
		t.Fatalf("unexpected observation failure report: %#v", reports)
	}
}

func TestServiceRunOnceRegistersPrivateNetworkObservation(t *testing.T) {
	desired := networkDesired()
	reports := []privateNetworkReport{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/v1/device-auth/challenge":
			json.NewEncoder(response).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/device-auth/verify":
			json.NewEncoder(response).Encode(map[string]string{"token": "device-token"})
		case "/v1/device/heartbeat":
			json.NewEncoder(response).Encode(map[string]any{})
		case "/v1/device/operations/next":
			json.NewEncoder(response).Encode(map[string]any{"operation": nil})
		case "/v1/device/vpn/reconcile":
			json.NewEncoder(response).Encode(clientVPNCatalog{ModuleState: "disabled", Items: []clientVPNEnvironment{}})
		case "/v1/device/private-network/reconcile":
			if request.Header.Get("authorization") != "Bearer device-token" {
				t.Error("private network reconcile was not authenticated")
			}
			json.NewEncoder(response).Encode(desired)
		case "/v1/device/private-network/" + networkProfileID + "/report":
			var report privateNetworkReport
			if err := json.NewDecoder(request.Body).Decode(&report); err != nil {
				t.Errorf("invalid observation report: %v", err)
			}
			reports = append(reports, report)
			response.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected endpoint in service run: %s", request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service := &serviceRuntime{
		base: server.URL,
		dir:  dir,
		key:  key,
		routeCheck: func(address netip.Addr) (bool, error) {
			return address == netip.MustParseAddr("10.20.0.8"), nil
		},
	}
	if err = writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	if err = service.runOnce(); err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].ObservedState != "active" || reports[0].Revision != 7 || len(reports[0].ConfigDigest) != 64 {
		t.Fatalf("service run did not register the verified profile observation: %#v", reports)
	}
	if status := service.readPersisted(); status.LastError != "" {
		t.Fatalf("service run recorded an unexpected error: %#v", status)
	}
}

func TestPrivateNetworkObservationRejectsUnsupportedResourcesWithoutActive(t *testing.T) {
	host := &observedNetworkHost{hasRoute: func(netip.Addr) (bool, error) { return true, nil }}
	plan := networkruntime.ProfilePlan{Profile: networkruntime.Profile{PathMode: "direct", ReturnMode: "routed", DNSMode: "local"}, Resources: []networkruntime.Resource{{Kind: "hostname", Address: "erp.example.test"}}}
	err := host.Apply(plan)
	var coded *networkruntime.HostError
	if !errors.As(err, &coded) || coded.Code != "resource_observation_unsupported" {
		t.Fatalf("unexpected host result: %v", err)
	}
	empty := networkruntime.ProfilePlan{Profile: networkruntime.Profile{PathMode: "direct", ReturnMode: "routed", DNSMode: "local"}}
	err = host.Apply(empty)
	if !errors.As(err, &coded) || coded.Code != "no_observable_resources" {
		t.Fatalf("unexpected empty-profile result: %v", err)
	}
}

func mustJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}
