package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nexo.local/agent/internal/clientipc"
	"nexo.local/agent/internal/updater"
)

func TestServiceStatusNeverReturnsPrivateMaterial(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service := &serviceRuntime{base: "http://127.0.0.1", dir: t.TempDir(), key: key}
	data, code := service.Handle(context.Background(), clientipc.Request{Version: 1, ID: "request_01", Action: "status"})
	if code != "" {
		t.Fatal(code)
	}
	raw, _ := json.Marshal(data)
	text := strings.ToLower(string(raw))
	for _, forbidden := range []string{"private", "claim_token", "certificate_pem", "bearer"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("status leaked %s", forbidden)
		}
	}
}

func TestServiceRejectsUnknownActionsAndEnrollmentFields(t *testing.T) {
	service := &serviceRuntime{dir: t.TempDir()}
	if _, code := service.Handle(context.Background(), clientipc.Request{Action: "shell"}); code != "unsupported_action" {
		t.Fatalf("unexpected code %q", code)
	}
	payload := json.RawMessage(`{"token":"12345678901234567890","name":"Endpoint","command":"whoami"}`)
	if _, code := service.Handle(context.Background(), clientipc.Request{Action: "enroll", Payload: payload}); code != "invalid_payload" {
		t.Fatalf("unexpected code %q", code)
	}
}

func TestServiceRateLimitsRepeatedMutations(t *testing.T) {
	service := &serviceRuntime{dir: t.TempDir()}
	if _, code := service.Handle(context.Background(), clientipc.Request{Action: "claim"}); code != "claim_failed" {
		t.Fatalf("unexpected first code %q", code)
	}
	if _, code := service.Handle(context.Background(), clientipc.Request{Action: "claim"}); code != "rate_limited" {
		t.Fatalf("unexpected repeated code %q", code)
	}
}

func TestServiceClearsPersistedErrorAfterSuccessfulMutation(t *testing.T) {
	service := &serviceRuntime{dir: t.TempDir()}
	service.recordError("enrollment_failed")
	service.clearError()
	if status := service.readPersisted(); status.LastError != "" {
		t.Fatalf("stale error was not cleared: %q", status.LastError)
	}
}

func TestWindowsClientServiceRejectsNodeIdentity(t *testing.T) {
	dir := t.TempDir()
	securityState, err := updater.InitializeSecurityState(agentVersion)
	if err != nil {
		t.Fatal(err)
	}
	if err = updater.SaveSecurityState(filepath.Join(dir, "update-security-state.bin"), securityState); err != nil {
		t.Fatal(err)
	}
	if err := writeState(dir, state{DeviceID: "node-id", Audience: "node"}); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err = runServiceUntil("http://127.0.0.1", dir, "unused", "", key, nil); err == nil || !strings.Contains(err.Error(), "endpoint identity") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestServiceHealthActionIsSmallAndReportsExactVersion(t *testing.T) {
	service := &serviceRuntime{dir: t.TempDir()}
	data, code := service.Handle(context.Background(), clientipc.Request{Version: clientipc.Version, ID: "health_001", Action: "health"})
	if code != "" {
		t.Fatal(code)
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	var health map[string]string
	if err = json.Unmarshal(encoded, &health); err != nil || health["service"] != "running" || health["agent_version"] != agentVersion || len(encoded) > 256 {
		t.Fatalf("unexpected health response %q err=%v", encoded, err)
	}
	if _, code = service.Handle(context.Background(), clientipc.Request{Version: clientipc.Version, ID: "health_002", Action: "health", Payload: json.RawMessage(`{"unexpected":true}`)}); code != "invalid_payload" {
		t.Fatalf("health accepted unexpected payload: %q", code)
	}
}

func TestVPNCatalogRejectsArbitraryTransportAndDuplicates(t *testing.T) {
	valid := clientVPNEnvironment{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 1194, Revision: 1}
	if err := validateVPNCatalog(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{valid}}); err != nil {
		t.Fatal(err)
	}
	invalid := valid
	invalid.Protocol = "tcp"
	if validateVPNCatalog(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{invalid}}) == nil {
		t.Fatal("tcp catalog entry accepted")
	}
	if validateVPNCatalog(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{valid, valid}}) == nil {
		t.Fatal("duplicate catalog entry accepted")
	}
	if validateVPNCatalog(clientVPNCatalog{ModuleState: "disabled", Items: []clientVPNEnvironment{valid}}) == nil {
		t.Fatal("disabled module returned environments")
	}
}

func TestVPNCatalogStatusIsSanitizedAndFailClosed(t *testing.T) {
	dir := t.TempDir()
	service := &serviceRuntime{dir: dir}
	catalog := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{{ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Name: "Oficina", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 2}}}
	if err := service.writeVPNCatalog(catalog); err != nil {
		t.Fatal(err)
	}
	if err := writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial"}); err != nil {
		t.Fatal(err)
	}
	status := service.status()
	if status.VPN.State != "catalog_ready" || len(status.VPN.Environments) != 1 || status.Modules["vpn"] != "enabled" {
		t.Fatalf("unexpected vpn status: %#v", status.VPN)
	}
	raw, _ := json.Marshal(status)
	for _, forbidden := range []string{"remote", "route", "command", "certificate_pem", "private"} {
		if strings.Contains(strings.ToLower(string(raw)), forbidden) {
			t.Fatalf("vpn status leaked %s", forbidden)
		}
	}
}

func TestVPNCSRKeyRemainsPrivateAndStable(t *testing.T) {
	service := &serviceRuntime{dir: t.TempDir()}
	environmentID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	first, err := service.ensureVPNCSR(environmentID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.ensureVPNCSR(environmentID)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || strings.Contains(first, "PRIVATE KEY") {
		t.Fatal("csr was unstable or leaked private key")
	}
	keyPath := filepath.Join(service.dir, "vpn", environmentID, "client.key")
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("unexpected private key mode %o", info.Mode().Perm())
	}
}

func TestEndpointCannotExecuteNodeCertificateOperation(t *testing.T) {
	result := executeOperation("endpoint", "endpoint.runtime_info.v1", "vpn.client_certificate.issue.v1", map[string]any{"request_id": "x"}, 1)
	if result.Status != "failed" || result.Result["code"] != "execution_error" {
		t.Fatal("endpoint executed node certificate operation")
	}
}

func TestVPNConnectionIPCRejectsArbitraryFieldsAndUnavailableRuntime(t *testing.T) {
	service := &serviceRuntime{dir: t.TempDir()}
	malicious := json.RawMessage(`{"environment_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","executable":"C:\\evil.exe"}`)
	if _, code := service.Handle(context.Background(), clientipc.Request{Action: "connect_vpn", Payload: malicious}); code != "invalid_payload" {
		t.Fatalf("arbitrary executable field accepted: %q", code)
	}
	valid := json.RawMessage(`{"environment_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}`)
	if _, code := service.Handle(context.Background(), clientipc.Request{Action: "connect_vpn", Payload: valid}); code != "vpn_runtime_unavailable" {
		t.Fatalf("unexpected unavailable runtime result: %q", code)
	}
}

func TestVPNCatalogAbsenceDoesNotRevokeCredential(t *testing.T) {
	envID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	revoked := false
	credentialQueries := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case r.URL.Path == "/v1/device-auth/challenge":
			json.NewEncoder(w).Encode(map[string]string{"challenge": "challenge"})
		case r.URL.Path == "/v1/device-auth/verify":
			json.NewEncoder(w).Encode(map[string]string{"token": "device-token"})
		case r.URL.Path == "/v1/device/vpn/reconcile":
			json.NewEncoder(w).Encode(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{}})
		case r.URL.Path == "/v1/device/vpn/credentials/"+envID:
			credentialQueries++
			if r.Header.Get("authorization") != "Bearer device-token" {
				t.Error("credential state query was not authenticated")
			}
			json.NewEncoder(w).Encode(vpnCredentialResponse{ID: "credential", EnvironmentID: envID, State: "issued", Serial: "aabbcc"})
		default:
			if strings.Contains(r.URL.Path, "/revoke") {
				revoked = true
			}
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service := &serviceRuntime{base: server.URL, dir: dir, key: key}
	if err = writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	previous := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{{ID: envID, Name: "Oficina", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}}}
	if err = service.writeVPNCatalog(previous); err != nil {
		t.Fatal(err)
	}
	credentialDirectory := filepath.Join(dir, "vpn", envID)
	if err = os.MkdirAll(credentialDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err = service.writeVPNCredentialStatus(envID, localVPNCredential{State: "issued", Serial: "aabbcc", NotAfter: "2027-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(credentialDirectory, "client.crt"), []byte("certificate"), 0644); err != nil {
		t.Fatal(err)
	}

	if err = service.syncVPNCatalog(); err != nil {
		t.Fatal(err)
	}

	if revoked {
		t.Fatal("credential was revoked on catalog absence — expected disconnect-only (fail-closed)")
	}
	if credentialQueries != 1 {
		t.Fatalf("absent credential state was not resolved through the authenticated endpoint: %d", credentialQueries)
	}
	if status := service.readVPNCredentialStatus(envID); status.State != "issued" {
		t.Fatalf("credential state changed to %q on absence; expected issued", status.State)
	}
	if _, err = os.Stat(filepath.Join(credentialDirectory, "client.crt")); err != nil {
		t.Fatal("credential material was removed on transient absence")
	}
}

func TestVPNExplicitRevocationForAbsentEnvironmentCleansMaterial(t *testing.T) {
	envID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case r.URL.Path == "/v1/device-auth/challenge":
			json.NewEncoder(w).Encode(map[string]string{"challenge": "challenge"})
		case r.URL.Path == "/v1/device-auth/verify":
			json.NewEncoder(w).Encode(map[string]string{"token": "device-token"})
		case r.URL.Path == "/v1/device/vpn/reconcile":
			json.NewEncoder(w).Encode(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{}})
		case r.URL.Path == "/v1/device/vpn/credentials/"+envID:
			json.NewEncoder(w).Encode(vpnCredentialResponse{ID: "credential", EnvironmentID: envID, State: "revoked", Serial: "ddeeff"})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	service := &serviceRuntime{base: server.URL, dir: dir, key: key}
	if err := writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	credentialDirectory := filepath.Join(dir, "vpn", envID)
	if err := os.MkdirAll(credentialDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := service.writeVPNCredentialStatus(envID, localVPNCredential{State: "issued", Serial: "ddeeff"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"client.key", "client.crt", "ca.crt", "tls-crypt.envelope"} {
		if err := os.WriteFile(filepath.Join(credentialDirectory, name), []byte("material"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	if err := service.syncVPNCatalog(); err != nil {
		t.Fatal(err)
	}
	if status := service.readVPNCredentialStatus(envID); status.State != "revoked" {
		t.Fatalf("explicit revocation was not persisted: %#v", status)
	}
	for _, name := range []string{"client.key", "client.crt", "ca.crt", "tls-crypt.envelope"} {
		if _, err := os.Stat(filepath.Join(credentialDirectory, name)); !os.IsNotExist(err) {
			t.Fatalf("revoked material survived: %s", name)
		}
	}
}

func TestVPNControlFailureFailsClosedWithoutDestructiveRevocation(t *testing.T) {
	envID := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	revoked := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/device-auth/challenge":
			json.NewEncoder(w).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/device-auth/verify":
			json.NewEncoder(w).Encode(map[string]string{"token": "device-token"})
		case "/v1/device/vpn/reconcile":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			if strings.Contains(r.URL.Path, "/revoke") {
				revoked = true
			}
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	service := &serviceRuntime{base: server.URL, dir: dir, key: key}
	if err := writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "vpn", envID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := service.writeVPNCredentialStatus(envID, localVPNCredential{State: "issued", Serial: "ffee"}); err != nil {
		t.Fatal(err)
	}
	if err := service.syncVPNCatalog(); err == nil {
		t.Fatal("control failure was reported as success")
	}
	if revoked {
		t.Fatal("control failure triggered a destructive revocation")
	}
	if status := service.readVPNCredentialStatus(envID); status.State != "issued" {
		t.Fatalf("control failure changed the credential state: %#v", status)
	}
}

func TestVPNUnknownCredentialKeepsMaterialOnTransientAbsence(t *testing.T) {
	envID := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/device-auth/challenge":
			json.NewEncoder(w).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/device-auth/verify":
			json.NewEncoder(w).Encode(map[string]string{"token": "device-token"})
		case "/v1/device/vpn/reconcile":
			json.NewEncoder(w).Encode(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{}})
		case "/v1/device/vpn/credentials/" + envID:
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	service := &serviceRuntime{base: server.URL, dir: dir, key: key}
	if err := writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	credentialDirectory := filepath.Join(dir, "vpn", envID)
	if err := os.MkdirAll(credentialDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := service.writeVPNCredentialStatus(envID, localVPNCredential{State: "issued", Serial: "0011"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(credentialDirectory, "client.crt"), []byte("certificate"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := service.syncVPNCatalog(); err != nil {
		t.Fatal(err)
	}
	if status := service.readVPNCredentialStatus(envID); status.State != "issued" {
		t.Fatalf("unknown credential state changed the local credential: %#v", status)
	}
	if _, err := os.Stat(filepath.Join(credentialDirectory, "client.crt")); err != nil {
		t.Fatal("unknown credential state removed local material")
	}
}

func TestVPNCredentialRevocationCleansAndReissuesWithNewCSR(t *testing.T) {
	envID := "abababab-abab-4bab-8bab-abababababab"
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/device-auth/challenge":
			json.NewEncoder(w).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/device-auth/verify":
			json.NewEncoder(w).Encode(map[string]string{"token": "device-token"})
		case "/v1/device/vpn/reconcile":
			json.NewEncoder(w).Encode(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{{ID: envID, Name: "Oficina", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}}})
		case "/v1/device/vpn/credentials":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("invalid credential request: %v", err)
			}
			requests = append(requests, body["csr_pem"])
			w.WriteHeader(http.StatusAccepted)
			if len(requests) == 1 {
				json.NewEncoder(w).Encode(vpnCredentialResponse{ID: "old", EnvironmentID: envID, State: "revoked", Serial: "aabbcc"})
			} else {
				json.NewEncoder(w).Encode(vpnCredentialResponse{ID: "new", EnvironmentID: envID, State: "pending"})
			}
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service := &serviceRuntime{base: server.URL, dir: dir, key: key}
	if err = writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	if err = service.syncVPNCatalog(); err != nil {
		t.Fatal(err)
	}
	if status := service.readVPNCredentialStatus(envID); status.State != "revoked" {
		t.Fatalf("revocation was not persisted: %#v", status)
	}
	for _, name := range []string{"client.key", "client.csr", "client.crt", "ca.crt", "tls-crypt.envelope"} {
		if _, statErr := os.Stat(filepath.Join(dir, "vpn", envID, name)); !os.IsNotExist(statErr) {
			t.Fatalf("revoked material survived: %s", name)
		}
	}
	if err = service.syncVPNCatalog(); err != nil {
		t.Fatal(err)
	}
	if status := service.readVPNCredentialStatus(envID); status.State != "pending" {
		t.Fatalf("reissue state was not persisted: %#v", status)
	}
	if len(requests) != 2 || requests[0] == requests[1] {
		t.Fatal("reissue did not use a fresh CSR after revocation cleanup")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "vpn", envID, "client.key")); statErr != nil {
		t.Fatal("new private key was not created for reissue")
	}
}

func TestVPNRevokedAbsentEnvironmentRetriesCleanup(t *testing.T) {
	envID := "acacacac-acac-4cac-8cac-acacacacacac"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/device-auth/challenge":
			json.NewEncoder(w).Encode(map[string]string{"challenge": "challenge"})
		case "/v1/device-auth/verify":
			json.NewEncoder(w).Encode(map[string]string{"token": "device-token"})
		case "/v1/device/vpn/reconcile":
			json.NewEncoder(w).Encode(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{}})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service := &serviceRuntime{base: server.URL, dir: dir, key: key}
	if err = writeState(dir, state{DeviceID: "device-id", Audience: "endpoint", Serial: "serial", CertificatePEM: "certificate"}); err != nil {
		t.Fatal(err)
	}
	credentialDirectory := filepath.Join(dir, "vpn", envID)
	if err = os.MkdirAll(credentialDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err = service.writeVPNCredentialStatus(envID, localVPNCredential{State: "revoked", Serial: "aabbcc"}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"client.key", "client.csr", "client.crt", "ca.crt", "tls-crypt.envelope"} {
		if err = os.WriteFile(filepath.Join(credentialDirectory, name), []byte("material"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = service.syncVPNCatalog(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"client.key", "client.csr", "client.crt", "ca.crt", "tls-crypt.envelope"} {
		if _, statErr := os.Stat(filepath.Join(credentialDirectory, name)); !os.IsNotExist(statErr) {
			t.Fatalf("revoked absent material survived: %s", name)
		}
	}
}
