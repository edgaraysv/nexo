package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

type request struct {
	DeviceID     string `json:"device_id"`
	TenantID     string `json:"tenant_id"`
	Audience     string `json:"audience"`
	PublicKeyPEM string `json:"public_key_pem"`
	ValidHours   int    `json:"valid_hours"`
}
type response struct {
	Serial         string `json:"serial"`
	CertificatePEM string `json:"certificate_pem"`
	NotBefore      string `json:"not_before"`
	NotAfter       string `json:"not_after"`
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
func main() {
	if len(os.Args) != 3 || os.Args[1] != "init" && os.Args[1] != "issue" {
		fail(fmt.Errorf("usage: nexo-issuer init|issue <ca-dir>"))
	}
	dir := os.Args[2]
	if os.Args[1] == "init" {
		if err := initCA(dir); err != nil {
			fail(err)
		}
		return
	}
	if err := issue(dir); err != nil {
		fail(err)
	}
}
func initCA(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "NEXO Local Development CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(30 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	cert, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(dir, "ca-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "ca-cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}), 0644)
}
func issue(dir string) error {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		return err
	}
	if (req.Audience != "endpoint" && req.Audience != "node") || req.ValidHours < 1 || req.ValidHours > 24 {
		return fmt.Errorf("invalid certificate request")
	}
	caPEM, err := os.ReadFile(filepath.Join(dir, "ca-cert.pem"))
	if err != nil {
		return err
	}
	keyPEM, err := os.ReadFile(filepath.Join(dir, "ca-key.pem"))
	if err != nil {
		return err
	}
	caBlock, _ := pem.Decode(caPEM)
	keyBlock, _ := pem.Decode(keyPEM)
	if caBlock == nil || keyBlock == nil {
		return fmt.Errorf("invalid ca")
	}
	ca, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		return err
	}
	rawKey, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		return err
	}
	caKey := rawKey.(*ecdsa.PrivateKey)
	publicBlock, _ := pem.Decode([]byte(req.PublicKeyPEM))
	if publicBlock == nil {
		return fmt.Errorf("invalid public key")
	}
	publicKey, err := x509.ParsePKIXPublicKey(publicBlock.Bytes)
	if err != nil {
		return err
	}
	ec, ok := publicKey.(*ecdsa.PublicKey)
	if !ok || ec.Curve != elliptic.P256() {
		return fmt.Errorf("public key must be P-256")
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	now := time.Now().UTC()
	until := now.Add(time.Duration(req.ValidHours) * time.Hour)
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: req.DeviceID, OrganizationalUnit: []string{req.TenantID}}, NotBefore: now.Add(-time.Minute), NotAfter: until, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, DNSNames: []string{req.Audience + ".devices.nexo.local"}}
	cert, err := x509.CreateCertificate(rand.Reader, tmpl, ca, ec, caKey)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(response{Serial: serial.Text(16), CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})), NotBefore: tmpl.NotBefore.Format(time.RFC3339), NotAfter: tmpl.NotAfter.Format(time.RFC3339)})
}
