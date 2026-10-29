package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"nexo.local/agent/internal/keystore"
	"nexo.local/agent/internal/vpnruntime"
)

type vpnCredentialResponse struct {
	ID                  string `json:"id"`
	EnvironmentID       string `json:"environment_id"`
	State               string `json:"state"`
	Serial              string `json:"serial,omitempty"`
	CertificatePEM      string `json:"certificate_pem,omitempty"`
	CACertificatePEM    string `json:"ca_certificate_pem,omitempty"`
	TLSCryptKeyEnvelope string `json:"tls_crypt_key_envelope,omitempty"`
	NotBefore           string `json:"not_before,omitempty"`
	NotAfter            string `json:"not_after,omitempty"`
	ErrorCode           string `json:"error_code,omitempty"`
}

type localVPNCredential struct {
	State     string `json:"state"`
	Serial    string `json:"serial,omitempty"`
	NotBefore string `json:"not_before,omitempty"`
	NotAfter  string `json:"not_after,omitempty"`
}

func (service *serviceRuntime) syncVPNCredentials(catalog clientVPNCatalog, token string) error {
	for _, environment := range catalog.Items {
		csr, err := service.ensureVPNCSR(environment.ID)
		if err != nil {
			return err
		}
		digest := sha256.Sum256([]byte(csr))
		var response vpnCredentialResponse
		if err = postWithToken(service.base, "/v1/device/vpn/credentials", map[string]string{"environment_id": environment.ID, "csr_pem": csr, "idempotency_key": "vpn-issue-" + hex.EncodeToString(digest[:16])}, &response, token); err != nil {
			return err
		}
		if response.EnvironmentID != environment.ID || !map[string]bool{"pending": true, "issued": true, "revocation_pending": true, "revoked": true, "failed": true}[response.State] {
			return errors.New("invalid vpn credential response")
		}
		if response.State == "issued" {
			if response.TLSCryptKeyEnvelope == "" {
				return errors.New("missing vpn tls crypt envelope")
			}
			if err = service.persistVPNCredential(environment.ID, response); err != nil {
				return err
			}
		} else {
			if err = service.writeVPNCredentialStatus(environment.ID, localVPNCredential{State: response.State, Serial: response.Serial, NotBefore: response.NotBefore, NotAfter: response.NotAfter}); err != nil {
				return err
			}
			if response.State == "revoked" {
				if err = service.removeRevokedVPNMaterial(environment.ID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (service *serviceRuntime) removeRevokedVPNMaterial(environmentID string) error {
	directory := filepath.Join(service.dir, "vpn", environmentID)
	var combined error
	for _, name := range []string{"client.key", "client.csr", "client.crt", "ca.crt", "tls-crypt.envelope"} {
		if err := os.Remove(filepath.Join(directory, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			combined = errors.Join(combined, err)
		}
	}
	return combined
}

// resolveAbsentVPNCredentials asks the authenticated control plane for the
// explicit state of credentials whose environment is no longer offered by the
// catalog. Only an authenticated revoked/revocation_pending answer is treated
// as a withdrawal; a missing row or a still-issued credential is a transient
// absence that keeps the credential and the connection intent.
func (service *serviceRuntime) resolveAbsentVPNCredentials(catalog clientVPNCatalog, token string) error {
	present := make(map[string]struct{}, len(catalog.Items))
	for _, environment := range catalog.Items {
		present[environment.ID] = struct{}{}
	}
	entries, err := os.ReadDir(filepath.Join(service.dir, "vpn"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		environmentID := entry.Name()
		if !entry.IsDir() || !vpnruntime.ValidEnvironmentID(environmentID) {
			continue
		}
		if _, offered := present[environmentID]; offered {
			continue
		}
		status := service.readVPNCredentialStatus(environmentID)
		if status.State == "" {
			continue
		}
		if status.State == "revoked" {
			// Retry cleanup even when the terminal state is already persisted.
			// A transient file lock must not make revoked key material permanent.
			// This is best-effort for an environment that is no longer offered:
			// an ACL failure must not fail-close unrelated healthy environments.
			_ = service.removeRevokedVPNMaterial(environmentID)
			continue
		}
		var response vpnCredentialResponse
		code, requestErr := getWithToken(service.base, "/v1/device/vpn/credentials/"+environmentID, &response, token)
		if requestErr != nil {
			return requestErr
		}
		if code == http.StatusNotFound {
			continue
		}
		if code != http.StatusOK {
			return errors.New("vpn credential state unavailable")
		}
		if response.EnvironmentID != environmentID || !map[string]bool{"pending": true, "issued": true, "revocation_pending": true, "revoked": true, "failed": true}[response.State] {
			return errors.New("invalid vpn credential response")
		}
		if response.State != "revoked" && response.State != "revocation_pending" {
			continue
		}
		if err = service.writeVPNCredentialStatus(environmentID, localVPNCredential{State: response.State, Serial: response.Serial, NotBefore: response.NotBefore, NotAfter: response.NotAfter}); err != nil {
			return err
		}
		if response.State == "revoked" {
			if err = service.removeRevokedVPNMaterial(environmentID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (service *serviceRuntime) revokeVPNCredential(environmentID string) error {
	status := service.readVPNCredentialStatus(environmentID)
	if status.State != "issued" || status.Serial == "" {
		return errors.New("issued vpn credential required")
	}
	_, session, err := authenticateSession(service.base, service.dir, service.key)
	if err != nil {
		return err
	}
	token, ok := session["token"].(string)
	if !ok {
		return errors.New("missing device session")
	}
	return service.revokeVPNCredentialWithToken(environmentID, token)
}

func (service *serviceRuntime) revokeVPNCredentialWithToken(environmentID, token string) error {
	status := service.readVPNCredentialStatus(environmentID)
	if status.State != "issued" || status.Serial == "" {
		return errors.New("issued vpn credential required")
	}
	digest := sha256.Sum256([]byte(environmentID + ":" + status.Serial))
	var response vpnCredentialResponse
	if err := postWithToken(service.base, "/v1/device/vpn/credentials/"+environmentID+"/revoke", map[string]string{"serial": status.Serial, "idempotency_key": "vpn-revoke-" + hex.EncodeToString(digest[:16])}, &response, token); err != nil {
		return err
	}
	if response.EnvironmentID != environmentID || response.Serial != status.Serial || !map[string]bool{"revocation_pending": true, "revoked": true}[response.State] {
		return errors.New("invalid vpn revocation response")
	}
	return service.writeVPNCredentialStatus(environmentID, localVPNCredential{State: response.State, Serial: response.Serial, NotBefore: status.NotBefore, NotAfter: status.NotAfter})
}

func (service *serviceRuntime) ensureVPNCSR(environmentID string) (string, error) {
	directory := filepath.Join(service.dir, "vpn", environmentID)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	csrPath, keyPath := filepath.Join(directory, "client.csr"), filepath.Join(directory, "client.key")
	key, err := keystore.LoadOrCreate(keyPath)
	if err != nil {
		return "", err
	}
	if info, statErr := os.Stat(keyPath); statErr != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		return "", errors.New("invalid vpn private key")
	}
	if csr, err := os.ReadFile(csrPath); err == nil {
		block, rest := pem.Decode(csr)
		if block == nil || block.Type != "CERTIFICATE REQUEST" || len(bytes.TrimSpace(rest)) != 0 {
			return "", errors.New("invalid stored csr")
		}
		request, parseErr := x509.ParseCertificateRequest(block.Bytes)
		if parseErr != nil || request.CheckSignature() != nil {
			return "", errors.New("invalid stored csr")
		}
		left, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
		right, _ := x509.MarshalPKIXPublicKey(request.PublicKey)
		if !bytes.Equal(left, right) {
			return "", errors.New("vpn csr key mismatch")
		}
		return string(csr), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "nexo-endpoint"}}, key)
	if err != nil {
		return "", err
	}
	csrPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})
	if err = writePrivateFile(csrPath, csrPEM, 0600); err != nil {
		return "", err
	}
	return string(csrPEM), nil
}

func (service *serviceRuntime) persistVPNCredential(environmentID string, response vpnCredentialResponse) error {
	directory := filepath.Join(service.dir, "vpn", environmentID)
	keyPath := filepath.Join(directory, "client.key")
	if _, err := os.Stat(keyPath); err != nil {
		return errors.New("vpn private key unavailable")
	}
	key, err := keystore.LoadOrCreate(keyPath)
	if err != nil {
		return err
	}
	certBlock, certRest := pem.Decode([]byte(response.CertificatePEM))
	caBlock, caRest := pem.Decode([]byte(response.CACertificatePEM))
	if certBlock == nil || certBlock.Type != "CERTIFICATE" || len(bytes.TrimSpace(certRest)) != 0 || caBlock == nil || caBlock.Type != "CERTIFICATE" || len(bytes.TrimSpace(caRest)) != 0 {
		return errors.New("invalid vpn credential pem")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return err
	}
	ca, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil || !ca.IsCA {
		return errors.New("invalid vpn ca")
	}
	if cert.CheckSignatureFrom(ca) != nil {
		return errors.New("invalid vpn certificate chain")
	}
	if _, err = vpnruntime.DecryptTLSCryptKey(key, environmentID, response.TLSCryptKeyEnvelope); err != nil {
		return errors.New("invalid vpn tls crypt credential")
	}
	left, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	right, _ := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if !bytes.Equal(left, right) {
		return errors.New("vpn key mismatch")
	}
	if response.Serial != hex.EncodeToString(cert.SerialNumber.Bytes()) || response.NotAfter == "" || time.Now().After(cert.NotAfter) {
		return errors.New("invalid vpn certificate metadata")
	}
	if err = writePrivateFile(filepath.Join(directory, "client.crt"), []byte(response.CertificatePEM), 0644); err != nil {
		return err
	}
	if err = writePrivateFile(filepath.Join(directory, "ca.crt"), []byte(response.CACertificatePEM), 0644); err != nil {
		return err
	}
	if err = writePrivateFile(filepath.Join(directory, "tls-crypt.envelope"), []byte(response.TLSCryptKeyEnvelope), 0600); err != nil {
		return err
	}
	return service.writeVPNCredentialStatus(environmentID, localVPNCredential{State: "issued", Serial: response.Serial, NotBefore: response.NotBefore, NotAfter: response.NotAfter})
}

func (service *serviceRuntime) writeVPNCredentialStatus(environmentID string, status localVPNCredential) error {
	raw, _ := json.Marshal(status)
	return writePrivateFile(filepath.Join(service.dir, "vpn", environmentID, "credential.json"), raw, 0600)
}
func (service *serviceRuntime) readVPNCredentialStatus(environmentID string) localVPNCredential {
	var status localVPNCredential
	raw, err := os.ReadFile(filepath.Join(service.dir, "vpn", environmentID, "credential.json"))
	if err == nil {
		_ = json.Unmarshal(raw, &status)
	}
	return status
}
func writePrivateFile(path string, value []byte, mode os.FileMode) error {
	temporary := path + ".new"
	if err := os.WriteFile(temporary, value, mode); err != nil {
		return err
	}
	if err := os.Chmod(temporary, mode); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, path)
}
