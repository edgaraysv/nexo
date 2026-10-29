//go:build linux

package vpnruntime

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
)

const (
	testEnvironment = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testRequest     = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	testTenant      = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	testDevice      = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
)

func TestClientCertificateIssueAndRevoke(t *testing.T) {
	root := t.TempDir()
	pki := filepath.Join(root, testEnvironment, "pki")
	if err := os.MkdirAll(pki, 0700); err != nil {
		t.Fatal(err)
	}
	if err := ensurePKI(pki, DesiredEnvironment{ID: testEnvironment}); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "untrusted-subject"}}, key)
	if err != nil {
		t.Fatal(err)
	}
	csr := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))
	issued, err := issueClientCertificate(root, testRequest, testEnvironment, testTenant, testDevice, csr)
	if err != nil {
		t.Fatal(err)
	}
	issuedAgain, err := issueClientCertificate(root, testRequest, testEnvironment, testTenant, testDevice, csr)
	if err != nil || issuedAgain.Serial != issued.Serial {
		t.Fatal("issuance was not idempotent")
	}
	staticKey, err := os.ReadFile(filepath.Join(pki, "tls-crypt.key"))
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := DecryptTLSCryptKey(key, testEnvironment, issued.TLSCryptKeyEnvelope)
	if err != nil || !bytes.Equal(decrypted, staticKey) {
		t.Fatalf("tls-crypt envelope did not recover environment key: %v", err)
	}
	if bytes.Contains([]byte(issued.TLSCryptKeyEnvelope), staticKey) || bytes.Contains([]byte(issued.TLSCryptKeyEnvelope), []byte("OpenVPN Static key")) {
		t.Fatal("static key was exposed in envelope")
	}
	block, _ := pem.Decode([]byte(issued.CertificatePEM))
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	caBlock, _ := pem.Decode([]byte(issued.CACertificatePEM))
	ca, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if certificate.Subject.CommonName != "nexo:"+testDevice {
		t.Fatal("csr subject was trusted")
	}
	if len(certificate.Subject.OrganizationalUnit) != 1 || certificate.Subject.OrganizationalUnit[0] != testTenant {
		t.Fatal("tenant was not bound into the certificate subject")
	}
	if len(certificate.Subject.CommonName) > 64 {
		t.Fatal("client common name exceeds OpenVPN limit")
	}
	if err = certificate.CheckSignatureFrom(ca); err != nil {
		t.Fatal(err)
	}
	if len(certificate.ExtKeyUsage) != 1 || certificate.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Fatal("client auth usage missing")
	}
	if bytes.Contains([]byte(issued.CertificatePEM), []byte("PRIVATE KEY")) || bytes.Contains([]byte(issued.CACertificatePEM), []byte("PRIVATE KEY")) {
		t.Fatal("private key leaked")
	}
	if err = revokeClientCertificate(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial); err != nil {
		t.Fatal(err)
	}
	if err = revokeClientCertificate(root, testRequest, testEnvironment, testTenant, testDevice, issued.Serial); err != nil {
		t.Fatal("revocation was not idempotent")
	}
	raw, err := os.ReadFile(filepath.Join(pki, "crl.pem"))
	if err != nil {
		t.Fatal(err)
	}
	crlBlock, _ := pem.Decode(raw)
	crl, err := x509.ParseRevocationList(crlBlock.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	serial := new(big.Int)
	serial.SetString(issued.Serial, 16)
	found := false
	for _, entry := range crl.RevokedCertificateEntries {
		if entry.SerialNumber.Cmp(serial) == 0 {
			found = true
		}
	}
	if !found {
		t.Fatal("serial missing from crl")
	}
}

func TestClientCertificateRejectsInvalidCSRAndWrongDeviceRevocation(t *testing.T) {
	root := t.TempDir()
	pki := filepath.Join(root, testEnvironment, "pki")
	if err := os.MkdirAll(pki, 0700); err != nil {
		t.Fatal(err)
	}
	if err := ensurePKI(pki, DesiredEnvironment{ID: testEnvironment}); err != nil {
		t.Fatal(err)
	}
	if _, err := issueClientCertificate(root, testRequest, testEnvironment, testTenant, testDevice, "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n"); err == nil {
		t.Fatal("invalid csr accepted")
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	issued, err := issueClientCertificate(root, testRequest, testEnvironment, testTenant, testDevice, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})))
	if err != nil {
		t.Fatal(err)
	}
	if err = revokeClientCertificate(root, testRequest, testEnvironment, testTenant, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", issued.Serial); err == nil {
		t.Fatal("wrong device revoked certificate")
	}
}
