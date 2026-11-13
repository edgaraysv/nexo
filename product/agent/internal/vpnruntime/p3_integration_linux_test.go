//go:build linux && p3integration

// P3 end-to-end harness. It is opt-in and never runs under the normal
// `go test ./...` gate.
//
// Preferred reproducible runner:
//
//	bash product/agent/internal/vpnruntime/testdata/mvpn08-p3/run.sh all
//
// It prepares the PKI/records, starts the isolated OpenVPN 2.6.14 fixture,
// waits for target+control in status without disconnecting, runs this test,
// records evidence, and removes only the fixture container. The manual steps
// below remain available for auditing:
//
// Step 1 — prepare a temporary root inside the isolated fixture volume:
//
//	docker run --rm -v "$PWD":/src -v /tmp/opencode/mvpn08/p3-root:/p3root \
//	  -w /src/product/agent golang:1.27.3-bookworm \
//	  env NEXO_MVPN08_P3_ROOT=/p3root \
//	      NEXO_MVPN08_P3_ENV=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6 \
//	      NEXO_MVPN08_P3_TENANT=cccccccc-cccc-4ccc-8ccc-cccccccccccc \
//	      NEXO_MVPN08_P3_TARGET_REQUEST=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
//	      NEXO_MVPN08_P3_TARGET_DEVICE=11111111-1111-4111-8111-111111111111 \
//	      NEXO_MVPN08_P3_CONTROL_REQUEST=dddddddd-dddd-4ddd-8ddd-dddddddddddd \
//	      NEXO_MVPN08_P3_CONTROL_DEVICE=22222222-2222-4222-8222-222222222222 \
//	  go test -tags p3integration ./internal/vpnruntime -run TestP3Prepare -v
//
// Step 2 — start OpenVPN 2.6.14 in the isolated fixture with the generated
// server PKI and connect the target + control clients. The required directives
// are:
//
//	ca <root>/<env>/pki/ca.crt
//	cert <root>/<env>/pki/server.crt
//	key <root>/<env>/pki/server.key
//	crl-verify <root>/<env>/pki/crl.pem
//	tls-crypt <root>/<env>/pki/tls-crypt.key
//	management <root>/<env>/mgmt.sock unix
//	management-client-user root
//
// Client configs use <root>/clients/target.{crt,key} and
// <root>/clients/control.{crt,key}, the CA at <root>/clients/ca.crt, and the
// environment tls-crypt key at <root>/<env>/pki/tls-crypt.key.
//
// Step 3 — run the revocation flow against the live daemon:
//
//	docker run --rm -v "$PWD":/src -v /tmp/opencode/mvpn08/p3-root:/p3root \
//	  -w /src/product/agent golang:1.27.3-bookworm \
//	  env NEXO_MVPN08_P3=1 NEXO_MVPN08_P3_ROOT=/p3root \
//	  go test -tags p3integration ./internal/vpnruntime -run TestP3RevocationEndToEnd -v
package vpnruntime

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type p3Identity struct {
	RequestID       string `json:"request_id"`
	DeviceID        string `json:"device_id"`
	Serial          string `json:"serial"`
	CertificatePath string `json:"certificate_path"`
	KeyPath         string `json:"key_path"`
}

type p3Fixture struct {
	Root              string     `json:"root"`
	EnvironmentID     string     `json:"environment_id"`
	TenantID          string     `json:"tenant_id"`
	Target            p3Identity `json:"target"`
	Control           p3Identity `json:"control"`
	ControlCommonName string     `json:"control_common_name"`
	PKIDirectory      string     `json:"pki_directory"`
	ClientDirectory   string     `json:"client_directory"`
}

func TestP3Prepare(t *testing.T) {
	root := os.Getenv("NEXO_MVPN08_P3_ROOT")
	environmentID := os.Getenv("NEXO_MVPN08_P3_ENV")
	tenantID := os.Getenv("NEXO_MVPN08_P3_TENANT")
	if root == "" || !ValidEnvironmentID(environmentID) || !credentialID.MatchString(tenantID) {
		t.Skip("P3 prepare env is not configured")
	}
	environmentDirectory := filepath.Join(root, environmentID)
	pki := filepath.Join(environmentDirectory, "pki")
	if err := os.MkdirAll(pki, 0711); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(environmentDirectory, 0711); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(pki, 0711); err != nil {
		t.Fatal(err)
	}
	if err := ensurePKI(pki, DesiredEnvironment{ID: environmentID}); err != nil {
		t.Fatal(err)
	}
	clientDirectory := filepath.Join(root, "clients")
	if err := os.MkdirAll(clientDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	target := p3IssueIdentity(t, root, environmentID, tenantID, clientDirectory,
		os.Getenv("NEXO_MVPN08_P3_TARGET_REQUEST"),
		os.Getenv("NEXO_MVPN08_P3_TARGET_DEVICE"),
		"target")
	control := p3IssueIdentity(t, root, environmentID, tenantID, clientDirectory,
		os.Getenv("NEXO_MVPN08_P3_CONTROL_REQUEST"),
		os.Getenv("NEXO_MVPN08_P3_CONTROL_DEVICE"),
		"control")
	fixture := p3Fixture{
		Root:              root,
		EnvironmentID:     environmentID,
		TenantID:          tenantID,
		Target:            target,
		Control:           control,
		ControlCommonName: "nexo:" + control.DeviceID,
		PKIDirectory:      pki,
		ClientDirectory:   clientDirectory,
	}
	raw, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "p3.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("P3 fixture: %s", raw)
}

func p3IssueIdentity(t *testing.T, root, environmentID, tenantID, clientDirectory, requestID, deviceID, prefix string) p3Identity {
	t.Helper()
	if !credentialID.MatchString(requestID) || !credentialID.MatchString(deviceID) {
		t.Fatalf("P3 %s identity is not configured", prefix)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "p3-" + prefix}}, key)
	if err != nil {
		t.Fatal(err)
	}
	csrPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))
	issued, err := issueClientCertificate(root, requestID, environmentID, tenantID, deviceID, csrPEM)
	if err != nil {
		t.Fatal(err)
	}
	keyRaw, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certificatePath := filepath.Join(clientDirectory, prefix+".crt")
	keyPath := filepath.Join(clientDirectory, prefix+".key")
	if err = os.WriteFile(certificatePath, []byte(issued.CertificatePEM), 0644); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyRaw}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(clientDirectory, "ca.crt"), []byte(issued.CACertificatePEM), 0644); err != nil {
		t.Fatal(err)
	}
	return p3Identity{RequestID: requestID, DeviceID: deviceID, Serial: issued.Serial, CertificatePath: certificatePath, KeyPath: keyPath}
}

func TestP3RevocationEndToEnd(t *testing.T) {
	if os.Getenv("NEXO_MVPN08_P3") != "1" {
		t.Skip("P3 end-to-end is opt-in")
	}
	root := os.Getenv("NEXO_MVPN08_P3_ROOT")
	if root == "" {
		t.Skip("P3 root is not configured")
	}
	raw, err := os.ReadFile(filepath.Join(root, "p3.json"))
	if err != nil {
		t.Fatalf("read p3 fixture: %v", err)
	}
	var fixture p3Fixture
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(root, fixture.EnvironmentID, managementSocketName)
	if _, err = os.Stat(socketPath); err != nil {
		t.Fatalf("management socket is not available: %v", err)
	}
	disconnectCalls := 0
	disconnect := func(root, environmentID, deviceID string, t0 time.Time, clock managementClock) (disconnectOutcome, error) {
		disconnectCalls++
		return disconnectOpenVPNClient(root, environmentID, deviceID, t0, clock)
	}
	result, err := revokeClientCertificateWithClock(
		root,
		fixture.Target.RequestID,
		fixture.EnvironmentID,
		fixture.TenantID,
		fixture.Target.DeviceID,
		fixture.Target.Serial,
		disconnect,
		systemManagementClock{},
	)
	if err != nil {
		t.Fatalf("revocation failed: %v (result=%#v)", err, result)
	}
	if disconnectCalls != 1 {
		t.Fatalf("disconnect flow was invoked %d times, want exactly one", disconnectCalls)
	}
	if !result.Revoked || !result.ManagementCommandSent || !result.ManagementAccepted || !result.DisconnectConfirmed {
		t.Fatalf("P3 did not observe the required effects: %#v", result)
	}
	if !result.AcceptWithinBudget || !result.DisconnectWithinBudget {
		t.Fatalf("P3 SLA not met: %.3f ms accept, %.3f ms disconnect: %#v",
			float64(result.Timings.AcceptElapsedNS)/1e6,
			float64(result.Timings.DisconnectElapsedNS)/1e6,
			result.Timings)
	}
	if result.Timings.AcceptElapsedNS <= 0 || result.Timings.DisconnectElapsedNS < result.Timings.AcceptElapsedNS {
		t.Fatalf("P3 timing order is invalid: %#v", result.Timings)
	}
	if result.Timings.AcceptElapsedNS > int64(2*time.Second) || result.Timings.DisconnectElapsedNS > int64(10*time.Second) {
		t.Fatalf("P3 timings exceed the approved limits: %#v", result.Timings)
	}
	// Explicit evidence lines for go-test.log. These are synthetic CNs only.
	t.Logf("AcceptElapsedNS=%d", result.Timings.AcceptElapsedNS)
	t.Logf("DisconnectElapsedNS=%d", result.Timings.DisconnectElapsedNS)
	t.Logf("target_absent=true")
	t.Logf("control_present=true")
	summary, _ := json.Marshal(result)
	t.Logf("P3 PASS candidate: %s", summary)
}
