package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"nexo.local/agent/internal/vpnruntime"
)

type fakeVPNReconciler struct {
	calls int
	items []vpnruntime.DesiredEnvironment
}

func (f *fakeVPNReconciler) Reconcile(items []vpnruntime.DesiredEnvironment, _ vpnruntime.Progress) []vpnruntime.Result {
	f.calls++
	f.items = items
	results := make([]vpnruntime.Result, 0, len(items))
	for _, item := range items {
		results = append(results, vpnruntime.Result{ID: item.ID, Revision: item.Revision, ObservedState: "active", ConfigDigest: strings.Repeat("a", 64)})
	}
	return results
}

func TestNodeVPNReconciliationUsesAuthenticatedClosedContract(t *testing.T) {
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6"
	reports := []map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/v1/node-auth/challenge":
			json.NewEncoder(response).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/node-auth/verify":
			json.NewEncoder(response).Encode(map[string]string{"token": "node-token"})
		case "/v1/node/heartbeat":
			if request.Header.Get("authorization") != "Bearer node-token" {
				t.Error("missing node token")
			}
			response.WriteHeader(http.StatusNoContent)
		case "/v1/node/vpn-environments/reconcile":
			json.NewEncoder(response).Encode(map[string]any{"items": []map[string]any{{"id": id, "engine": "openvpn", "protocol": "udp", "listenerPort": 21194, "tunnelIpv4Cidr": "10.90.0.0/24", "ipv6Enabled": false, "namespaceName": "nexo-aaaaaaaaaaaa", "desiredState": "active", "revision": 3}}})
		case "/v1/node/vpn-environments/" + id + "/report":
			var report map[string]any
			_ = json.NewDecoder(request.Body).Decode(&report)
			reports = append(reports, report)
			response.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected path %s", request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	directory := t.TempDir()
	if err := writeState(directory, state{DeviceID: "node-id", Audience: "node", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	reconciler := &fakeVPNReconciler{}
	if err = reconcileNodeVPN(server.URL, directory, key, reconciler, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if reconciler.calls != 1 || len(reconciler.items) != 1 || len(reports) != 1 {
		t.Fatalf("unexpected reconciliation calls=%d reports=%#v", reconciler.calls, reports)
	}
	if reports[0]["observed_state"] != "active" {
		t.Fatalf("unexpected reports %#v", reports)
	}
}

func TestNodeVPNReconciliationNeverPrereportsProvisioning(t *testing.T) {
	id := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	var provisioned bool
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/v1/node-auth/challenge":
			json.NewEncoder(response).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/node-auth/verify":
			json.NewEncoder(response).Encode(map[string]string{"token": "node-token"})
		case "/v1/node/heartbeat":
			response.WriteHeader(http.StatusNoContent)
		case "/v1/node/vpn-environments/reconcile":
			json.NewEncoder(response).Encode(map[string]any{"items": []map[string]any{{"id": id, "engine": "openvpn", "protocol": "udp", "listenerPort": 21194, "tunnelIpv4Cidr": "10.90.0.0/24", "ipv6Enabled": false, "namespaceName": "nexo-bbbbbbbbbbbb", "desiredState": "active", "revision": 1}}})
		case "/v1/node/vpn-environments/" + id + "/report":
			var report map[string]any
			_ = json.NewDecoder(request.Body).Decode(&report)
			if report["observed_state"] == "provisioning" {
				provisioned = true
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	directory := t.TempDir()
	_ = writeState(directory, state{DeviceID: "node-id", Audience: "node", Serial: "serial", CertificatePEM: "certificate"})
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	_ = reconcileNodeVPN(server.URL, directory, key, &fakeVPNReconciler{}, &strings.Builder{})
	if provisioned {
		t.Fatal("reconciler pre-reported provisioning state")
	}
}

func TestNodeVPNReconciliationRejectsUnsafeEnvironmentIDBeforeMutation(t *testing.T) {
	reports := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/v1/node-auth/challenge":
			json.NewEncoder(response).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/node-auth/verify":
			json.NewEncoder(response).Encode(map[string]string{"token": "node-token"})
		case "/v1/node/heartbeat":
			response.WriteHeader(http.StatusNoContent)
		case "/v1/node/vpn-environments/reconcile":
			json.NewEncoder(response).Encode(map[string]any{"items": []map[string]any{{"id": "../../host", "desiredState": "active"}}})
		default:
			reports++
			response.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	directory := t.TempDir()
	_ = writeState(directory, state{DeviceID: "node-id", Audience: "node", Serial: "serial", CertificatePEM: "certificate"})
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	reconciler := &fakeVPNReconciler{}
	if err := reconcileNodeVPN(server.URL, directory, key, reconciler, &strings.Builder{}); err == nil {
		t.Fatal("unsafe environment accepted")
	}
	if reconciler.calls != 0 || reports != 0 {
		t.Fatalf("mutation occurred calls=%d reports=%d", reconciler.calls, reports)
	}
}

func TestNodeVPNReconciliationReportsEveryEnvironmentDespiteOneFailure(t *testing.T) {
	first := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7"
	second := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7"
	var reported []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/v1/node-auth/challenge":
			json.NewEncoder(response).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/node-auth/verify":
			json.NewEncoder(response).Encode(map[string]string{"token": "node-token"})
		case "/v1/node/heartbeat":
			response.WriteHeader(http.StatusNoContent)
		case "/v1/node/vpn-environments/reconcile":
			json.NewEncoder(response).Encode(map[string]any{"items": []map[string]any{
				{"id": first, "engine": "openvpn", "protocol": "udp", "listenerPort": 21194, "tunnelIpv4Cidr": "10.90.0.0/24", "ipv6Enabled": false, "namespaceName": "nexo-aaaaaaaaaaaa", "desiredState": "active", "revision": 1},
				{"id": second, "engine": "openvpn", "protocol": "udp", "listenerPort": 21195, "tunnelIpv4Cidr": "10.91.0.0/24", "ipv6Enabled": false, "namespaceName": "nexo-bbbbbbbbbbbb", "desiredState": "active", "revision": 1},
			}})
		case "/v1/node/vpn-environments/" + first + "/report":
			reported = append(reported, first)
			response.WriteHeader(http.StatusConflict)
		case "/v1/node/vpn-environments/" + second + "/report":
			reported = append(reported, second)
			response.WriteHeader(http.StatusNoContent)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	directory := t.TempDir()
	if err := writeState(directory, state{DeviceID: "node-id", Audience: "node", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err = reconcileNodeVPN(server.URL, directory, key, &fakeVPNReconciler{}, &strings.Builder{}); err == nil {
		t.Fatal("report failure was not surfaced")
	}
	if len(reported) != 2 || reported[0] != first || reported[1] != second {
		t.Fatalf("second environment report was skipped: %#v", reported)
	}
}
