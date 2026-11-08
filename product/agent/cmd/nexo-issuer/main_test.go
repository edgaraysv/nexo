package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIssueNodeCredentialSupportsThirtyDays(t *testing.T) {
	dir := t.TempDir()
	if err := initCA(dir); err != nil {
		t.Fatal(err)
	}
	request, startedAt := testIssuerRequest(t, "node", 720), time.Now().UTC()
	issued := runIssuerRequest(t, dir, request)
	block, _ := pem.Decode([]byte(issued.CertificatePEM))
	if block == nil {
		t.Fatal("issuer returned invalid certificate PEM")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if got := certificate.NotAfter.Sub(startedAt); got < 30*24*time.Hour-time.Minute {
		t.Fatalf("node certificate TTL is less than 30 days: %s", got)
	}
}

func TestIssueRejectsLongEndpointTTL(t *testing.T) {
	err := runIssuerError(t, t.TempDir(), testIssuerRequest(t, "endpoint", 720))
	if err == nil || !strings.Contains(err.Error(), "invalid certificate request") {
		t.Fatalf("expected extended endpoint TTL rejection, got %v", err)
	}
}

func TestIssueRejectsLeafBeyondCARemainingValidity(t *testing.T) {
	dir := t.TempDir()
	if err := writeTestCA(dir, 7*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	err := runIssuerError(t, dir, testIssuerRequest(t, "node", 720))
	if err == nil || !strings.Contains(err.Error(), "ca validity insufficient") {
		t.Fatalf("expected insufficient CA validity rejection, got %v", err)
	}
}

func testIssuerRequest(t *testing.T, audience string, hours int) request {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return request{DeviceID: "55555555-5555-4555-8555-555555555555", TenantID: "provider", Audience: audience, PublicKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), ValidHours: hours}
}

func runIssuerRequest(t *testing.T, dir string, req request) response {
	t.Helper()
	value, err := runIssuer(t, dir, req)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func runIssuerError(t *testing.T, dir string, req request) error {
	t.Helper()
	_, err := runIssuer(t, dir, req)
	return err
}

func runIssuer(t *testing.T, dir string, req request) (response, error) {
	t.Helper()
	input, err := os.CreateTemp(t.TempDir(), "issuer-input-*.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.NewEncoder(input).Encode(req); err != nil {
		t.Fatal(err)
	}
	if _, err = input.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	output, err := os.CreateTemp(t.TempDir(), "issuer-output-*.json")
	if err != nil {
		t.Fatal(err)
	}
	oldStdin, oldStdout := os.Stdin, os.Stdout
	os.Stdin, os.Stdout = input, output
	err = issue(dir)
	os.Stdin, os.Stdout = oldStdin, oldStdout
	_ = input.Close()
	if err != nil {
		_ = output.Close()
		return response{}, err
	}
	if _, err = output.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	var value response
	err = json.NewDecoder(output).Decode(&value)
	_ = output.Close()
	return value, err
}

func writeTestCA(dir string, validity time.Duration) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return err
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Test CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(validity), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(dir, "ca-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "ca-cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
}
