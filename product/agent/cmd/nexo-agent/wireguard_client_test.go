package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWireGuardClientKeyIsLocalStableAndFailsClosed(t *testing.T) {
	directory := t.TempDir()
	first, publicKey, err := ensureWireGuardActiveKey(directory, clientRuntimeEnvironmentID)
	if err != nil {
		t.Fatal(err)
	}
	second, repeatedPublicKey, err := ensureWireGuardActiveKey(directory, clientRuntimeEnvironmentID)
	if err != nil {
		t.Fatal(err)
	}
	if publicKey != repeatedPublicKey || string(first.Bytes()) != string(second.Bytes()) {
		t.Fatal("WireGuard identity changed across reads")
	}
	path := filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "wireguard", "client.key")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private key permissions are not 0600: %v", err)
	}
	state, err := os.ReadFile(filepath.Join(filepath.Dir(path), "keys.json"))
	if err != nil || strings.Contains(string(state), string(first.Bytes())) || strings.Contains(string(state), "PRIVATE KEY") {
		t.Fatal("local key state contains private key material")
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, _, err = ensureWireGuardActiveKey(directory, clientRuntimeEnvironmentID); err == nil {
		t.Fatal("missing previously-created client key was silently replaced")
	}
}

func TestWireGuardClientKeyRejectsMalformedExistingFileWithoutReplacement(t *testing.T) {
	directory := t.TempDir()
	keyDirectory := filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "wireguard")
	if err := os.MkdirAll(keyDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(keyDirectory, "client.key")
	if err := os.WriteFile(path, []byte("not a WireGuard key\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ensureWireGuardActiveKey(directory, clientRuntimeEnvironmentID); err == nil {
		t.Fatal("invalid existing key was accepted")
	}
	contents, err := os.ReadFile(path)
	if err != nil || string(contents) != "not a WireGuard key\n" {
		t.Fatal("invalid key was overwritten")
	}
}

func TestWireGuardPendingKeyPromotesOnlyWhenControlPlaneReturnsIt(t *testing.T) {
	directory := t.TempDir()
	_, original, err := ensureWireGuardActiveKey(directory, clientRuntimeEnvironmentID)
	if err != nil {
		t.Fatal(err)
	}
	_, candidate, err := ensureWireGuardPendingKey(directory, clientRuntimeEnvironmentID)
	if err != nil {
		t.Fatal(err)
	}
	if candidate == original {
		t.Fatal("rotation candidate reused the active key")
	}
	if _, err = wireGuardClientKeyForPeer(directory, clientRuntimeEnvironmentID, candidate); err != nil {
		t.Fatal(err)
	}
	state, err := wireGuardStateForEnvironment(directory, clientRuntimeEnvironmentID)
	if err != nil || state.ActiveFingerprint != wireGuardFingerprint(candidate) || state.PendingFingerprint != "" {
		t.Fatalf("candidate key was not promoted: %#v, %v", state, err)
	}
	if _, err = os.Stat(filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "wireguard", "client.pending.key")); !os.IsNotExist(err) {
		t.Fatal("promoted candidate file remains staged")
	}
}

func TestWireGuardRegistrationSendsOnlyClientPublicKey(t *testing.T) {
	serverKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverPublic := base64.StdEncoding.EncodeToString(serverKey.PublicKey().Bytes())
	var posted map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/device/vpn/wireguard/peers" || r.Header.Get("authorization") != "Bearer device-token" {
			t.Errorf("unexpected authenticated registration request: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
			t.Error(err)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(wireGuardRegistrationResponse{PeerID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", State: "pending", TunnelIPv4: "10.8.0.2", PublicKeyFingerprint: wireGuardFingerprint(posted["public_key"].(string))})
	}))
	defer server.Close()

	service := &serviceRuntime{base: server.URL, dir: t.TempDir()}
	catalog := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "wireguard", Protocol: "udp", ListenerPort: 51820, Revision: 1, ServerPublicKey: serverPublic}}}
	if err = service.syncWireGuardPeers(&catalog, "device-token"); err != nil {
		t.Fatal(err)
	}
	postedPublicKey, _ := posted["public_key"].(string)
	if posted["environment_id"] != clientRuntimeEnvironmentID || posted["action"] != "register" || !validWireGuardClientKey(postedPublicKey) {
		t.Fatalf("unexpected registration payload: %#v", posted)
	}
	if len(posted) != 3 {
		t.Fatalf("registration included unexpected fields: %#v", posted)
	}
	encoded, _ := json.Marshal(posted)
	privateFile, err := os.ReadFile(filepath.Join(service.dir, "vpn", clientRuntimeEnvironmentID, "wireguard", "client.key"))
	if err != nil || strings.Contains(string(encoded), strings.TrimSpace(string(privateFile))) || catalog.Items[0].WireGuardState != "pending_approval" {
		t.Fatal("client private key leaked or pending state was not retained")
	}
}

func TestWireGuardConfigIsNarrowAndAppliedWithoutClaimingHandshake(t *testing.T) {
	directory := t.TempDir()
	clientKey, clientPublic, err := ensureWireGuardActiveKey(directory, clientRuntimeEnvironmentID)
	if err != nil {
		t.Fatal(err)
	}
	serverKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverPublic := base64.StdEncoding.EncodeToString(serverKey.PublicKey().Bytes())
	environment := clientVPNEnvironment{
		ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "wireguard", Protocol: "udp", ListenerPort: 51820, Revision: 2,
		ServerPublicKey: serverPublic,
		WireGuardPeer:   &clientWireGuardPeer{PeerID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", TunnelIPv4: "10.8.0.2", ClientPublicKey: clientPublic, ServerTunnelIPv4: "10.8.0.1", ServerPublicKey: serverPublic, ListenerPort: 51820, AllowedIPs: []string{"10.8.0.1/32"}, PersistentKeepaliveSeconds: 25},
	}
	config, err := renderManagedWireGuard(environment, "control.example.invalid", clientKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"[Interface]", "Address = 10.8.0.2/32", "MTU = 1420", "[Peer]", "AllowedIPs = 10.8.0.1/32", "Endpoint = control.example.invalid:51820", "PersistentKeepalive = 25"} {
		if !strings.Contains(config, required) {
			t.Fatalf("WireGuard config missing %q", required)
		}
	}
	for _, forbidden := range []string{"0.0.0.0/0", "::/0", "PresharedKey", "PostUp", "Table ="} {
		if strings.Contains(config, forbidden) {
			t.Fatalf("WireGuard config contains forbidden value %q", forbidden)
		}
	}

	launcher := &fakeVPNLaunchWithCleaner{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatal(err)
	}
	if runtime.connection(environment.ID).State != vpnConfigured {
		t.Fatal("WireGuard service installation was incorrectly reported as a verified handshake")
	}
	actual, err := os.ReadFile(launcher.config)
	if err != nil || string(actual) != config {
		t.Fatalf("applied config mismatch: %v", err)
	}
	info, err := os.Stat(launcher.config)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("transient configuration containing the private key is not protected")
	}
	if err = runtime.disconnect(environment.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(launcher.config); !os.IsNotExist(err) {
		t.Fatal("transient WireGuard config remained after disconnect")
	}
}

func TestValidateVPNCatalogAcceptsOnlyConstrainedWireGuardPeer(t *testing.T) {
	clientKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverPublic := base64.StdEncoding.EncodeToString(serverKey.PublicKey().Bytes())
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "wireguard", Protocol: "udp", ListenerPort: 51820, Revision: 1, ServerPublicKey: serverPublic, WireGuardPeer: &clientWireGuardPeer{PeerID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", TunnelIPv4: "10.8.0.2", ClientPublicKey: wireGuardPublicKey(clientKey), ServerTunnelIPv4: "10.8.0.1", ServerPublicKey: serverPublic, ListenerPort: 51820, AllowedIPs: []string{"10.8.0.1/32"}}}
	if err = validateVPNCatalog(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{environment}}); err != nil {
		t.Fatal(err)
	}
	environment.WireGuardPeer.AllowedIPs = []string{"0.0.0.0/0"}
	if err = validateVPNCatalog(clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{environment}}); err == nil {
		t.Fatal("default route was accepted for a WireGuard peer")
	}
}
