package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nexo.local/agent/internal/keystore"
	"nexo.local/agent/internal/vpnruntime"
)

const clientRuntimeEnvironmentID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

type fakeVPNProcess struct{ stopped bool }

func (process *fakeVPNProcess) Stop() error { process.stopped = true; return nil }

type fakeVPNLaunch struct {
	config  string
	process *fakeVPNProcess
	onLine  func(string)
	onExit  func(error)
	starts  int
}

type fakeVPNLaunchWithCleaner struct {
	fakeVPNLaunch
	cleaned []string
}

func (launcher *fakeVPNLaunchWithCleaner) StopEnvironment(environmentID string) error {
	launcher.cleaned = append(launcher.cleaned, environmentID)
	return nil
}

func (launcher *fakeVPNLaunch) Start(config string, onLine func(string), onExit func(error)) (vpnProcess, error) {
	launcher.starts++
	launcher.config = config
	launcher.onLine = onLine
	launcher.onExit = onExit
	launcher.process = &fakeVPNProcess{}
	return launcher.process, nil
}

func TestManagedVPNConnectDisconnectAndSanitizedState(t *testing.T) {
	directory := t.TempDir()
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	writeRuntimeCredential(t, directory, environment.ID)
	launcher := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(launcher.config)
	if err != nil {
		t.Fatal(err)
	}
	text := string(config)
	for _, expected := range []string{"remote control.example.invalid 21194", "verify-x509-name " + environment.ID + " name", "remote-cert-tls server", "persist-key", `pull-filter ignore "redirect-gateway"`, "tls-crypt "} {
		if !strings.Contains(text, expected) {
			t.Fatalf("config missing %q", expected)
		}
	}
	tlsKeyPath := filepath.Join(directory, "vpn", environment.ID, "runtime", "tls-crypt.key")
	tlsKeyInfo, err := os.Stat(tlsKeyPath)
	if err != nil || tlsKeyInfo.Mode().Perm() != 0600 {
		t.Fatal("transient tls-crypt key is not protected")
	}
	tlsKey, err := os.ReadFile(tlsKeyPath)
	if err != nil || !strings.Contains(string(tlsKey), "BEGIN OpenVPN Static key V1") {
		t.Fatal("transient tls-crypt key was not materialized")
	}
	for _, forbidden := range []string{"http://", "https://", "route ", "management ", "script-security 2"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("config contains %q", forbidden)
		}
	}
	launcher.onLine("Initialization Sequence Completed")
	if state := runtime.connection(environment.ID); state.State != vpnConnected || !state.Desired {
		t.Fatalf("unexpected connected state %#v", state)
	}
	if _, err = os.Stat(filepath.Join(directory, "vpn", environment.ID, "runtime", "client.key")); !os.IsNotExist(err) {
		t.Fatal("transient private key remained after connection")
	}
	if _, err = os.Stat(tlsKeyPath); !os.IsNotExist(err) {
		t.Fatal("transient tls-crypt key remained after connection")
	}
	stateRaw, err := os.ReadFile(runtime.statePath())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(stateRaw)), "path") || strings.Contains(string(stateRaw), "PRIVATE KEY") {
		t.Fatal("runtime state leaked material")
	}
	if err = runtime.disconnect(environment.ID); err != nil {
		t.Fatal(err)
	}
	if !launcher.process.stopped || runtime.connection(environment.ID).State != vpnDisconnected {
		t.Fatal("vpn process was not disconnected")
	}
}

func TestManagedVPNStartupAndDisconnectCleanNativeWireGuardService(t *testing.T) {
	directory := t.TempDir()
	launcher := &fakeVPNLaunchWithCleaner{}
	if err := os.MkdirAll(filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	configName := "nexo-" + strings.ReplaceAll(clientRuntimeEnvironmentID, "-", "") + ".conf"
	if err := os.WriteFile(filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "runtime", configName), []byte("private-key-config"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "vpn-connections.json"), []byte(`{"`+clientRuntimeEnvironmentID+`":{"environment_id":"`+clientRuntimeEnvironmentID+`","engine":"wireguard","desired":true,"state":"configured"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if len(launcher.cleaned) < 1 || launcher.cleaned[0] != clientRuntimeEnvironmentID {
		t.Fatalf("startup did not stop the stale native service: %#v", launcher.cleaned)
	}
	if _, err = os.Stat(filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "runtime", configName)); !os.IsNotExist(err) {
		t.Fatal("stale transient WireGuard config was not removed")
	}
	if err = runtime.disconnect(clientRuntimeEnvironmentID); err != nil {
		t.Fatal(err)
	}
	if len(launcher.cleaned) < 2 {
		t.Fatal("disconnect after restart did not clean the native WireGuard service")
	}
}

func TestManagedVPNUsesValidatedRemoteHostOverride(t *testing.T) {
	t.Setenv("NEXO_VPN_REMOTE_HOST", "3.226.252.132")
	directory := t.TempDir()
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	writeRuntimeCredential(t, directory, environment.ID)
	launcher := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("http://127.0.0.1:13000", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(launcher.config)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "remote 3.226.252.132 21194") || strings.Contains(string(config), "remote 127.0.0.1 21194") {
		t.Fatal("managed VPN did not use the remote host override")
	}
}

func TestManagedVPNRejectsUnsafeRemoteHostOverride(t *testing.T) {
	for _, value := range []string{"", " 3.226.252.132", "https://3.226.252.132", "3.226.252.132:21194", "host name", ".host", "host..name", "-host"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("NEXO_VPN_REMOTE_HOST", value)
			if _, err := newManagedVPNRuntime("http://127.0.0.1:13000", t.TempDir(), &fakeVPNLaunch{}); err == nil {
				t.Fatal("unsafe remote host override was accepted")
			}
		})
	}
}

func TestManagedVPNRecoversDesiredConnectionAndFailsClosed(t *testing.T) {
	directory := t.TempDir()
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	writeRuntimeCredential(t, directory, environment.ID)
	first := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, first)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatal(err)
	}
	first.onLine("Initialization Sequence Completed")
	runtime.shutdown()
	second := &fakeVPNLaunch{}
	restarted, err := newManagedVPNRuntime("https://control.example.invalid", directory, second)
	if err != nil {
		t.Fatal(err)
	}
	catalog := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{environment}}
	credential := func(string) localVPNCredential {
		return localVPNCredential{State: "issued", NotAfter: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
	}
	if err = restarted.reconcile(catalog, credential); err != nil {
		t.Fatal(err)
	}
	if second.process == nil {
		t.Fatal("desired vpn connection was not recovered")
	}
	revoked := func(string) localVPNCredential { return localVPNCredential{State: "revoked"} }
	if err = restarted.reconcile(catalog, revoked); err != nil {
		t.Fatal(err)
	}
	state := restarted.connection(environment.ID)
	if !second.process.stopped || state.Desired || state.State != vpnError || state.LastError != "credential_unavailable" {
		t.Fatalf("vpn did not fail closed: %#v", state)
	}
}

func TestManagedVPNCatalogAbsencePreservesDesiredForReconnect(t *testing.T) {
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	directory := t.TempDir()
	writeRuntimeCredential(t, directory, environment.ID)
	launcher := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatal(err)
	}
	issued := func(string) localVPNCredential {
		return localVPNCredential{State: "issued", NotAfter: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
	}
	catalog := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{environment}}
	if err = runtime.reconcile(catalog, issued); err != nil {
		t.Fatal(err)
	}
	if launcher.process == nil {
		t.Fatal("vpn not started")
	}

	empty := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{}}
	if err = runtime.reconcile(empty, issued); err != nil {
		t.Fatal(err)
	}
	state := runtime.connection(environment.ID)
	if !state.Desired {
		t.Fatal("Desired cleared on catalog absence — expected preservation for reconnect")
	}

	if err = runtime.reconcile(catalog, issued); err != nil {
		t.Fatal(err)
	}
	state = runtime.connection(environment.ID)
	if !state.Desired {
		t.Fatal("Desired not preserved after catalog returned")
	}
}

func TestManagedVPNRejectsUntrustedInputs(t *testing.T) {
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	if _, err := renderManagedOpenVPN(environment, "bad\nhost", "/ca", "/cert", "/key", "/tls-crypt"); err == nil {
		t.Fatal("host injection accepted")
	}
	if _, err := renderManagedOpenVPN(environment, "vpn.example.invalid", "relative", "/cert", "/key", "/tls-crypt"); err == nil {
		t.Fatal("relative path accepted")
	}
	environment.Protocol = "tcp"
	if _, err := renderManagedOpenVPN(environment, "vpn.example.invalid", "/ca", "/cert", "/key", "/tls-crypt"); err == nil {
		t.Fatal("arbitrary transport accepted")
	}
}

func TestManagedVPNDoesNotReplaceMissingPrivateKey(t *testing.T) {
	directory := t.TempDir()
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	writeRuntimeCredential(t, directory, environment.ID)
	keyPath := filepath.Join(directory, "vpn", environment.ID, "client.key")
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, &fakeVPNLaunch{})
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err == nil {
		t.Fatal("missing private key was accepted")
	}
	if _, err = os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatal("missing private key was silently replaced")
	}
}

func TestManagedVPNStartupRemovesStaleTransientTLSCryptMaterial(t *testing.T) {
	directory := t.TempDir()
	transient := filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "runtime")
	if err := os.MkdirAll(transient, 0700); err != nil {
		t.Fatal(err)
	}
	secretPath := filepath.Join(transient, "tls-crypt.key")
	if err := os.WriteFile(secretPath, []byte("synthetic-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newManagedVPNRuntime("https://control.example.invalid", directory, &fakeVPNLaunch{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(secretPath); !os.IsNotExist(err) {
		t.Fatal("stale transient tls-crypt key survived restart")
	}
	if _, err := os.Stat(filepath.Join(directory, "vpn", clientRuntimeEnvironmentID, "tls-crypt.envelope")); !os.IsNotExist(err) {
		t.Fatal("startup cleanup touched persistent credential material")
	}
}

func writeRuntimeCredential(t *testing.T, directory, environmentID string) {
	t.Helper()
	credentialDirectory := filepath.Join(directory, "vpn", environmentID)
	if err := os.MkdirAll(credentialDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	key, err := keystore.LoadOrCreate(filepath.Join(credentialDirectory, "client.key"))
	if err != nil {
		t.Fatal(err)
	}
	static := []byte("-----BEGIN OpenVPN Static key V1-----\n" + strings.Repeat("0123456789abcdef", 32) + "\n-----END OpenVPN Static key V1-----\n")
	envelope, err := vpnruntime.EncryptTLSCryptKey(&key.PublicKey, environmentID, static)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(credentialDirectory, "tls-crypt.envelope"), []byte(envelope), 0600); err != nil {
		t.Fatal(err)
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	caTemplate := x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test ca"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, &caTemplate, &caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	serial := big.NewInt(42)
	certificateTemplate := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "test client"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	certificateDER, err := x509.CreateCertificate(rand.Reader, &certificateTemplate, &caTemplate, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(credentialDirectory, "client.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER}), 0644); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(credentialDirectory, "ca.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0644); err != nil {
		t.Fatal(err)
	}
	status := localVPNCredential{State: "issued", Serial: hex.EncodeToString(serial.Bytes()), NotBefore: certificateTemplate.NotBefore.Format(time.RFC3339), NotAfter: certificateTemplate.NotAfter.Format(time.RFC3339)}
	raw, _ := json.Marshal(status)
	if err = os.WriteFile(filepath.Join(credentialDirectory, "credential.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestManagedVPNCatalogAbsenceStopsProcessAndKeepsCredential(t *testing.T) {
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	directory := t.TempDir()
	writeRuntimeCredential(t, directory, environment.ID)
	launcher := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatal(err)
	}
	launcher.onLine("Initialization Sequence Completed")
	issued := func(string) localVPNCredential {
		return localVPNCredential{State: "issued", NotAfter: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
	}
	empty := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{}}
	if err = runtime.reconcile(empty, issued); err != nil {
		t.Fatal(err)
	}
	state := runtime.connection(environment.ID)
	if !state.Desired || state.State != vpnError || state.LastError != "environment_unavailable" {
		t.Fatalf("absence did not fail closed while preserving intent: %#v", state)
	}
	if launcher.process == nil || !launcher.process.stopped {
		t.Fatal("vpn process was not stopped on catalog absence")
	}
	if _, err = os.Stat(filepath.Join(directory, "vpn", environment.ID, "client.key")); err != nil {
		t.Fatal("credential material was removed on catalog absence")
	}

	starting := launcher.starts
	catalog := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{environment}}
	if err = runtime.reconcile(catalog, issued); err != nil {
		t.Fatal(err)
	}
	if launcher.starts != starting+1 {
		t.Fatalf("authorized environment did not relaunch: starts=%d", launcher.starts)
	}
	if state = runtime.connection(environment.ID); state.State != vpnConnecting {
		t.Fatalf("state was declared without a new handshake: %#v", state)
	}
	launcher.onLine("Initialization Sequence Completed")
	if state = runtime.connection(environment.ID); state.State != vpnConnected {
		t.Fatalf("state did not become connected after a new handshake: %#v", state)
	}
}

func TestManagedVPNRevokedCredentialCancelsIntentAndDoesNotRelaunch(t *testing.T) {
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	directory := t.TempDir()
	writeRuntimeCredential(t, directory, environment.ID)
	launcher := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatal(err)
	}
	launcher.onLine("Initialization Sequence Completed")
	catalog := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{environment}}
	pending := func(string) localVPNCredential { return localVPNCredential{State: "revocation_pending"} }
	if err = runtime.reconcile(catalog, pending); err != nil {
		t.Fatal(err)
	}
	state := runtime.connection(environment.ID)
	if state.Desired || state.State != vpnError {
		t.Fatalf("explicit revocation did not cancel the intent: %#v", state)
	}
	launcher.onLine("")
	starting := launcher.starts
	if err = runtime.reconcile(catalog, pending); err != nil {
		t.Fatal(err)
	}
	if launcher.starts != starting {
		t.Fatal("revoked credential was relaunched")
	}
}

func TestManagedVPNEnvironmentAbsenceDoesNotStopOtherEnvironment(t *testing.T) {
	first := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa A", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	second := clientVPNEnvironment{ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Name: "Empresa B", Engine: "openvpn", Protocol: "udp", ListenerPort: 21195, Revision: 1}
	directory := t.TempDir()
	writeRuntimeCredential(t, directory, first.ID)
	writeRuntimeCredential(t, directory, second.ID)
	launcher := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(first); err != nil {
		t.Fatal(err)
	}
	launcher.onLine("Initialization Sequence Completed")
	if err = runtime.connect(second); err != nil {
		t.Fatal(err)
	}
	launcher.onLine("Initialization Sequence Completed")
	issued := func(string) localVPNCredential {
		return localVPNCredential{State: "issued", NotAfter: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
	}
	catalog := clientVPNCatalog{ModuleState: "enabled", Items: []clientVPNEnvironment{second}}
	if err = runtime.reconcile(catalog, issued); err != nil {
		t.Fatal(err)
	}
	if state := runtime.connection(second.ID); state.State != vpnConnected {
		t.Fatalf("remaining environment was disturbed: %#v", state)
	}
	if launcher.process == nil || launcher.process.stopped {
		t.Fatal("remaining environment process was stopped")
	}
	if state := runtime.connection(first.ID); state.Desired {
		t.Fatalf("absent environment kept an active intent: %#v", state)
	}
}

func TestSameCredentialSerialHandlesLeadingZero(t *testing.T) {
	// big.Int.Text(16) drops leading zero nibbles; hex.EncodeToString of full bytes keeps them.
	// A serial whose first byte is 0x0d produces "0df1..." stored but "df1..." from Text(16).
	serial := new(big.Int).SetBytes([]byte{0x0d, 0xf1, 0x90, 0x43, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01})
	stored := hex.EncodeToString(serial.Bytes())
	if serial.Text(16) == stored {
		t.Fatal("test setup: serial does not exhibit the leading-zero discrepancy")
	}
	if !sameCredentialSerial(serial, stored) {
		t.Fatal("sameCredentialSerial rejected a valid serial with a leading-zero nibble")
	}
	different := new(big.Int).Add(serial, big.NewInt(1))
	if sameCredentialSerial(different, stored) {
		t.Fatal("sameCredentialSerial accepted a different serial value")
	}
}

func TestManagedVPNConnectSucceedsWithLeadingZeroSerial(t *testing.T) {
	environment := clientVPNEnvironment{ID: clientRuntimeEnvironmentID, Name: "Empresa", Engine: "openvpn", Protocol: "udp", ListenerPort: 21194, Revision: 1}
	directory := t.TempDir()
	writeRuntimeCredentialWithSerial(t, directory, environment.ID, []byte{0x0d, 0xf1, 0x90, 0x43, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01})
	launcher := &fakeVPNLaunch{}
	runtime, err := newManagedVPNRuntime("https://control.example.invalid", directory, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.connect(environment); err != nil {
		t.Fatalf("connect failed with leading-zero serial: %v", err)
	}
	if launcher.starts != 1 {
		t.Fatal("OpenVPN was not launched")
	}
}

func writeRuntimeCredentialWithSerial(t *testing.T, directory, environmentID string, serialBytes []byte) {
	t.Helper()
	credentialDirectory := filepath.Join(directory, "vpn", environmentID)
	if err := os.MkdirAll(credentialDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	key, err := keystore.LoadOrCreate(filepath.Join(credentialDirectory, "client.key"))
	if err != nil {
		t.Fatal(err)
	}
	static := []byte("-----BEGIN OpenVPN Static key V1-----\n" + strings.Repeat("0123456789abcdef", 32) + "\n-----END OpenVPN Static key V1-----\n")
	envelope, err := vpnruntime.EncryptTLSCryptKey(&key.PublicKey, environmentID, static)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(credentialDirectory, "tls-crypt.envelope"), []byte(envelope), 0600); err != nil {
		t.Fatal(err)
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	caTemplate := x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test ca"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, &caTemplate, &caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	serial := new(big.Int).SetBytes(serialBytes)
	certTemplate := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "test client"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	certDER, err := x509.CreateCertificate(rand.Reader, &certTemplate, &caTemplate, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(credentialDirectory, "client.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0644); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(credentialDirectory, "ca.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0644); err != nil {
		t.Fatal(err)
	}
	stored := hex.EncodeToString(serial.Bytes())
	status := localVPNCredential{State: "issued", Serial: stored, NotBefore: certTemplate.NotBefore.Format(time.RFC3339), NotAfter: certTemplate.NotAfter.Format(time.RFC3339)}
	raw, _ := json.Marshal(status)
	if err = os.WriteFile(filepath.Join(credentialDirectory, "credential.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestSameCredentialSerialNormalizesLeadingZeroes(t *testing.T) {
	parse := func(value string) *big.Int {
		parsed, ok := new(big.Int).SetString(value, 16)
		if !ok {
			t.Fatalf("invalid test serial %q", value)
		}
		return parsed
	}
	tests := []struct {
		name        string
		certificate *big.Int
		credential  string
		want        bool
	}{
		{name: "leading zero", certificate: parse("df19043f45c22ba95814666be5eb62f"), credential: "0df19043f45c22ba95814666be5eb62f", want: true},
		{name: "identical", certificate: parse("abcdef"), credential: "abcdef", want: true},
		{name: "uppercase", certificate: parse("abcdef"), credential: "ABCDEF", want: true},
		{name: "different", certificate: parse("abcdef"), credential: "abcdee", want: false},
		{name: "invalid", certificate: parse("abcdef"), credential: "not-hex", want: false},
		{name: "empty", certificate: parse("abcdef"), credential: "", want: false},
		{name: "negative credential", certificate: parse("abcdef"), credential: "-abcdef", want: false},
		{name: "zero", certificate: big.NewInt(0), credential: "0", want: false},
		{name: "nil certificate", certificate: nil, credential: "abcdef", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := sameCredentialSerial(test.certificate, test.credential); got != test.want {
				t.Fatalf("sameCredentialSerial(%v, %q) = %v, want %v", test.certificate, test.credential, got, test.want)
			}
		})
	}
}
