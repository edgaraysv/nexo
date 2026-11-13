//go:build linux

package vpnruntime

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var credentialID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

type ClientCertificate struct {
	Serial              string `json:"serial"`
	CertificatePEM      string `json:"certificate_pem"`
	CACertificatePEM    string `json:"ca_certificate_pem"`
	TLSCryptKeyEnvelope string `json:"tls_crypt_key_envelope"`
	NotBefore           string `json:"not_before"`
	NotAfter            string `json:"not_after"`
}

type issuedClientRecord struct {
	RequestID     string            `json:"request_id"`
	TenantID      string            `json:"tenant_id"`
	DeviceID      string            `json:"device_id"`
	EnvironmentID string            `json:"environment_id"`
	Certificate   ClientCertificate `json:"certificate"`
	Revoked       bool              `json:"revoked"`
	CSRSHA256     string            `json:"csr_sha256"`
}

// RevocationStatusTiming records one status 3 read from its write start to the
// complete END frame, relative to T0.
type RevocationStatusTiming struct {
	StartNS int64 `json:"start_ns"`
	EndNS   int64 `json:"end_ns"`
}

// RevocationTimings contains durations measured with the same monotonic clock
// from T0, the entry of the local revocation flow. Only elapsed nanoseconds are
// serialized; wall-clock instants are never reported as monotonic values.
// SLA comparisons use the duration values directly, never a lossy ms field.
type RevocationTimings struct {
	ValidationEndNS      int64                    `json:"validation_end_ns"`
	RecordReadEndNS      int64                    `json:"record_read_end_ns"`
	CRLStartNS           int64                    `json:"crl_start_ns"`
	CRLPublishedNS       int64                    `json:"crl_published_ns"`
	RecordUpdatedNS      int64                    `json:"record_updated_ns"`
	ConnectStartNS       int64                    `json:"connect_start_ns"`
	DialStartNS          int64                    `json:"dial_start_ns"`
	DialEndNS            int64                    `json:"dial_end_ns"`
	GreetingEndNS        int64                    `json:"greeting_end_ns"`
	InitialStatusStartNS int64                    `json:"initial_status_start_ns"`
	InitialStatusEndNS   int64                    `json:"initial_status_end_ns"`
	PreKillStatusStartNS int64                    `json:"pre_kill_status_start_ns"`
	PreKillStatusEndNS   int64                    `json:"pre_kill_status_end_ns"`
	KillWriteStartNS     int64                    `json:"kill_write_start_ns"`
	KillWriteEndNS       int64                    `json:"kill_write_end_ns"`
	AcceptTerminalNS     int64                    `json:"accept_terminal_ns"`
	FinalStatusStartNS   int64                    `json:"final_status_start_ns"`
	FinalStatusEndNS     int64                    `json:"final_status_end_ns"`
	FinalStatusPolls     []RevocationStatusTiming `json:"final_status_polls,omitempty"`
	// T_accept - T0: complete SUCCESS: terminal received from management.
	AcceptElapsedNS int64 `json:"accept_elapsed_ns"`
	// T_caída - T0: complete final status 3 with the target absent and a
	// control peer still present.
	DisconnectElapsedNS int64 `json:"disconnect_elapsed_ns"`
}

// RevocationResult reports the separately observable effects of a revocation.
// DisconnectRequested/ManagementAccepted mean OpenVPN management accepted the
// client-kill command with a complete SUCCESS: terminal; they never mean the
// peer is gone. DisconnectConfirmed is the only field that supports a
// disconnected claim: it is set only after a complete final status 3 shows the
// target CN absent and the control peer still present.
type RevocationResult struct {
	Serial                     string            `json:"serial"`
	Revoked                    bool              `json:"revoked"`
	DisconnectRequested        bool              `json:"disconnect_requested"`
	ManagementCommandSent      bool              `json:"management_command_sent"`
	ManagementCommandAttempted bool              `json:"management_command_attempted"`
	ManagementWritePartial     bool              `json:"management_write_partial"`
	ManagementAccepted         bool              `json:"management_accepted"`
	DisconnectConfirmed        bool              `json:"disconnect_confirmed"`
	AcceptWithinBudget         bool              `json:"accept_within_budget"`
	DisconnectWithinBudget     bool              `json:"disconnect_within_budget"`
	Timings                    RevocationTimings `json:"timings"`
}

// ErrRevocationPublished marks partial failures where the CRL rename already
// happened. Callers must keep the credential revoked and must not report a
// confirmed disconnect.
var ErrRevocationPublished = errors.New("revocation published but client disconnect unconfirmed")

// The following sentinels separate pre-publication, published, and
// post-publication outcomes. The disconnect/record sentinels also match
// ErrRevocationPublished so existing partial-failure handling remains valid.
var (
	ErrRevocationPublishFailed = errors.New("revocation CRL publication failed")
	ErrRevocationSLAExceeded   = errors.New("revocation SLA exceeded")
	ErrDisconnectNotAttempted  = fmt.Errorf("%w: disconnect not attempted", ErrRevocationPublished)
	ErrDisconnectRejected      = fmt.Errorf("%w: management rejected disconnect", ErrRevocationPublished)
	ErrDisconnectUnconfirmed   = fmt.Errorf("%w: management disconnect unconfirmed", ErrRevocationPublished)
	ErrRevocationRecordUpdate  = fmt.Errorf("%w: durable client record update failed", ErrRevocationPublished)
)

type clientDisconnector func(root, environmentID, deviceID string, t0 time.Time, clock managementClock) (disconnectOutcome, error)

func IssueClientCertificate(requestID, environmentID, tenantID, deviceID, csrPEM string) (ClientCertificate, error) {
	return issueClientCertificate(nativeRoot, requestID, environmentID, tenantID, deviceID, csrPEM)
}

func RevokeClientCertificate(requestID, environmentID, tenantID, deviceID, serial string) (RevocationResult, error) {
	return revokeClientCertificate(nativeRoot, requestID, environmentID, tenantID, deviceID, serial)
}

func issueClientCertificate(root, requestID, environmentID, tenantID, deviceID, csrPEM string) (ClientCertificate, error) {
	var result ClientCertificate
	if !credentialID.MatchString(requestID) || !ValidEnvironmentID(environmentID) || !credentialID.MatchString(tenantID) || !credentialID.MatchString(deviceID) || len(csrPEM) > 8192 {
		return result, errors.New("invalid credential request")
	}
	pki := filepath.Join(root, environmentID, "pki")
	if err := validatePKI(pki); err != nil {
		return result, err
	}
	if info, err := os.Stat(filepath.Join(pki, "crl.pem")); err != nil || validateCRL(pki, info.Mode().Perm()) != nil {
		return result, errors.New("invalid crl")
	}
	csrHash := sha256.Sum256([]byte(csrPEM))
	recordPath := filepath.Join(pki, "clients", requestID+".json")
	if raw, err := os.ReadFile(recordPath); err == nil {
		var record issuedClientRecord
		if json.Unmarshal(raw, &record) != nil || record.RequestID != requestID || record.TenantID != tenantID || record.DeviceID != deviceID || record.EnvironmentID != environmentID || record.CSRSHA256 != hex.EncodeToString(csrHash[:]) {
			return result, errors.New("credential record mismatch")
		}
		record.Certificate.TLSCryptKeyEnvelope, err = makeTLSCryptEnvelope(pki, environmentID, csrPEM)
		if err != nil {
			return result, err
		}
		return record.Certificate, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	block, rest := pem.Decode([]byte(csrPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(bytes.TrimSpace(rest)) != 0 || len(block.Bytes) > 4096 {
		return result, errors.New("invalid csr")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		return result, errors.New("invalid csr")
	}
	publicKey, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() {
		return result, errors.New("invalid csr key")
	}
	ca, caKey, caPEM, err := readCA(pki)
	if err != nil {
		return result, err
	}
	serialBytes := make([]byte, 16)
	if _, err = rand.Read(serialBytes); err != nil {
		return result, err
	}
	serialBytes[0] &= 0x7f
	serialBytes[0] |= 0x01
	serial := new(big.Int).SetBytes(serialBytes)
	now := time.Now().UTC()
	notAfter := now.Add(24 * time.Hour)
	if notAfter.After(ca.NotAfter) {
		notAfter = ca.NotAfter
	}
	if !notAfter.After(now.Add(time.Minute)) {
		return result, errors.New("ca expires too soon")
	}
	// OpenVPN limits the extracted common name to 64 characters. Device UUIDs
	// are globally unique, while the tenant remains bound into the subject OU.
	template := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "nexo:" + deviceID, OrganizationalUnit: []string{tenantID}}, NotBefore: now.Add(-time.Minute), NotAfter: notAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, &template, ca, publicKey, caKey)
	if err != nil {
		return result, err
	}
	result = ClientCertificate{Serial: hex.EncodeToString(serial.Bytes()), CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), CACertificatePEM: string(caPEM), NotBefore: template.NotBefore.Format(time.RFC3339), NotAfter: template.NotAfter.Format(time.RFC3339)}
	result.TLSCryptKeyEnvelope, err = makeTLSCryptEnvelope(pki, environmentID, csrPEM)
	if err != nil {
		return ClientCertificate{}, err
	}
	record := issuedClientRecord{RequestID: requestID, TenantID: tenantID, DeviceID: deviceID, EnvironmentID: environmentID, Certificate: result, CSRSHA256: hex.EncodeToString(csrHash[:])}
	raw, _ := json.Marshal(record)
	if err = os.MkdirAll(filepath.Dir(recordPath), 0700); err != nil {
		return ClientCertificate{}, err
	}
	if err = atomicWrite(filepath.Dir(recordPath), filepath.Base(recordPath), raw, 0600); err != nil {
		return ClientCertificate{}, err
	}
	return result, nil
}

func makeTLSCryptEnvelope(pki, environmentID, csrPEM string) (string, error) {
	block, rest := pem.Decode([]byte(csrPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(bytes.TrimSpace(rest)) != 0 {
		return "", errors.New("invalid csr")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		return "", errors.New("invalid csr")
	}
	publicKey, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() {
		return "", errors.New("invalid csr key")
	}
	staticKey, err := os.ReadFile(filepath.Join(pki, "tls-crypt.key"))
	if err != nil {
		return "", err
	}
	return EncryptTLSCryptKey(publicKey, environmentID, staticKey)
}

func revokeClientCertificate(root, requestID, environmentID, tenantID, deviceID, serial string) (RevocationResult, error) {
	return revokeClientCertificateWith(root, requestID, environmentID, tenantID, deviceID, serial, disconnectOpenVPNClient)
}

func revokeClientCertificateWith(root, requestID, environmentID, tenantID, deviceID, serial string, disconnect clientDisconnector) (RevocationResult, error) {
	return revokeClientCertificateWithClock(root, requestID, environmentID, tenantID, deviceID, serial, disconnect, systemManagementClock{})
}

func revokeClientCertificateWithClock(root, requestID, environmentID, tenantID, deviceID, serial string, disconnect clientDisconnector, clock managementClock) (RevocationResult, error) {
	// T0 is the entry of the local revocation flow, before any validation and
	// before the CRL is read or published.
	t0 := clock.Now()
	result := RevocationResult{Serial: serial}
	if !credentialID.MatchString(requestID) || !ValidEnvironmentID(environmentID) || !credentialID.MatchString(tenantID) || !credentialID.MatchString(deviceID) || !regexp.MustCompile(`^[a-f0-9]{8,64}$`).MatchString(serial) {
		return result, errors.New("invalid revocation request")
	}
	pki := filepath.Join(root, environmentID, "pki")
	if info, err := os.Stat(filepath.Join(pki, "crl.pem")); err != nil || validateCRL(pki, info.Mode().Perm()) != nil {
		return result, errors.New("invalid crl")
	}
	result.Timings.ValidationEndNS = elapsedNS(t0, clock.Now())
	entries, err := os.ReadDir(filepath.Join(pki, "clients"))
	if err != nil {
		return result, err
	}
	var record issuedClientRecord
	var recordPath string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(pki, "clients", entry.Name())
		raw, readErr := os.ReadFile(path)
		var candidate issuedClientRecord
		if readErr == nil && json.Unmarshal(raw, &candidate) == nil && candidate.Certificate.Serial == serial {
			record, recordPath = candidate, path
			break
		}
	}
	if recordPath == "" || record.RequestID != requestID || record.TenantID != tenantID || record.DeviceID != deviceID || record.EnvironmentID != environmentID {
		return result, errors.New("serial mismatch")
	}
	result.Timings.RecordReadEndNS = elapsedNS(t0, clock.Now())
	// Publish the CRL first. appendRevocation is idempotent, so a persisted
	// revocation still verifies/re-adds its entry instead of short-circuiting.
	result.Timings.CRLStartNS = elapsedNS(t0, clock.Now())
	if err = appendRevocation(pki, serial); err != nil {
		return result, errors.Join(ErrRevocationPublishFailed, err)
	}
	result.Revoked = true
	result.Timings.CRLPublishedNS = elapsedNS(t0, clock.Now())
	var recordErr error
	if !record.Revoked {
		record.Revoked = true
		raw, _ := json.Marshal(record)
		if err = atomicWrite(filepath.Dir(recordPath), filepath.Base(recordPath), raw, 0600); err != nil {
			recordErr = err
		}
	}
	result.Timings.RecordUpdatedNS = elapsedNS(t0, clock.Now())
	// Only now, after the atomic CRL rename, is a device-level disconnect
	// requested. A failure here must leave the revocation in place and must
	// never be reported as a confirmed disconnect.
	preTimings := result.Timings
	var (
		outcome       disconnectOutcome
		disconnectErr error
	)
	if disconnect == nil {
		disconnectErr = errors.Join(ErrDisconnectNotAttempted, errors.New("management disconnect unavailable"))
	} else {
		outcome, disconnectErr = disconnect(root, environmentID, deviceID, t0, clock)
		// Preserve pre-management marks; the disconnect outcome only
		// contributes its own phases.
		outcome.Timings.ValidationEndNS = preTimings.ValidationEndNS
		outcome.Timings.RecordReadEndNS = preTimings.RecordReadEndNS
		outcome.Timings.CRLStartNS = preTimings.CRLStartNS
		outcome.Timings.CRLPublishedNS = preTimings.CRLPublishedNS
		outcome.Timings.RecordUpdatedNS = preTimings.RecordUpdatedNS
		result.Timings = outcome.Timings
		result.ManagementCommandSent = outcome.Sent
		result.ManagementCommandAttempted = outcome.Attempted || outcome.Sent
		result.ManagementWritePartial = outcome.Partial
		result.ManagementAccepted = outcome.Accepted
		result.DisconnectConfirmed = outcome.Confirmed
		result.AcceptWithinBudget = outcome.AcceptWithinBudget
		result.DisconnectWithinBudget = outcome.DisconnectWithinBudget
		result.DisconnectRequested = outcome.Accepted
	}
	if disconnectErr != nil {
		switch {
		case errors.Is(disconnectErr, ErrDisconnectNotAttempted) || (!outcome.Sent && !outcome.Attempted):
			return result, errors.Join(ErrDisconnectNotAttempted, disconnectErr, recordErr)
		case errors.Is(disconnectErr, ErrDisconnectRejected):
			return result, errors.Join(ErrDisconnectRejected, disconnectErr, recordErr)
		default:
			return result, errors.Join(ErrDisconnectUnconfirmed, disconnectErr, recordErr)
		}
	}
	if recordErr != nil {
		return result, errors.Join(ErrRevocationRecordUpdate, recordErr)
	}
	if !result.DisconnectConfirmed {
		if !result.ManagementCommandSent {
			return result, ErrDisconnectNotAttempted
		}
		return result, ErrDisconnectUnconfirmed
	}
	if !result.AcceptWithinBudget || !result.DisconnectWithinBudget {
		return result, ErrRevocationSLAExceeded
	}
	return result, nil
}

func readCA(pki string) (*x509.Certificate, *ecdsa.PrivateKey, []byte, error) {
	certPEM, err := os.ReadFile(filepath.Join(pki, "ca.crt"))
	if err != nil {
		return nil, nil, nil, err
	}
	keyPEM, err := os.ReadFile(filepath.Join(pki, "ca.key"))
	if err != nil {
		return nil, nil, nil, err
	}
	certBlock, certRest := pem.Decode(certPEM)
	keyBlock, keyRest := pem.Decode(keyPEM)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" || len(bytes.TrimSpace(certRest)) != 0 || keyBlock == nil || keyBlock.Type != "EC PRIVATE KEY" || len(bytes.TrimSpace(keyRest)) != 0 {
		return nil, nil, nil, errors.New("invalid ca pki")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil || !cert.IsCA {
		return nil, nil, nil, errors.New("invalid ca certificate")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, nil, errors.New("invalid ca key")
	}
	return cert, key, certPEM, nil
}

func appendRevocation(pki, serialHex string) error {
	ca, key, _, err := readCA(pki)
	if err != nil {
		return err
	}
	path := filepath.Join(pki, "crl.pem")
	var revoked []x509.RevocationListEntry
	number := big.NewInt(1)
	if raw, readErr := os.ReadFile(path); readErr == nil {
		block, rest := pem.Decode(raw)
		if block == nil || block.Type != "X509 CRL" || len(bytes.TrimSpace(rest)) != 0 {
			return errors.New("invalid crl")
		}
		list, parseErr := x509.ParseRevocationList(block.Bytes)
		if parseErr != nil || list.CheckSignatureFrom(ca) != nil {
			return errors.New("invalid crl")
		}
		revoked = append(revoked, list.RevokedCertificateEntries...)
		number = new(big.Int).Add(list.Number, big.NewInt(1))
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	serial := new(big.Int)
	if _, ok := serial.SetString(serialHex, 16); !ok {
		return errors.New("invalid serial")
	}
	for _, entry := range revoked {
		if entry.SerialNumber.Cmp(serial) == 0 {
			return nil
		}
	}
	now := time.Now().UTC()
	revoked = append(revoked, x509.RevocationListEntry{SerialNumber: serial, RevocationTime: now})
	der, err := x509.CreateRevocationList(rand.Reader, &x509.RevocationList{Number: number, ThisUpdate: now, NextUpdate: now.Add(7 * 24 * time.Hour), RevokedCertificateEntries: revoked}, ca, key)
	if err != nil {
		return err
	}
	return atomicWrite(pki, "crl.pem", pem.EncodeToMemory(&pem.Block{Type: "X509 CRL", Bytes: der}), 0644)
}

func ensureEmptyCRL(pki string) error {
	path := filepath.Join(pki, "crl.pem")
	var entries []x509.RevocationListEntry
	number := big.NewInt(1)
	if info, err := os.Stat(path); err == nil {
		if err = validateCRL(pki, info.Mode().Perm()); err != nil {
			return err
		}
		raw, _ := os.ReadFile(path)
		block, _ := pem.Decode(raw)
		list, _ := x509.ParseRevocationList(block.Bytes)
		if list.NextUpdate.After(time.Now().UTC().Add(24 * time.Hour)) {
			return nil
		}
		entries = append(entries, list.RevokedCertificateEntries...)
		number = new(big.Int).Add(list.Number, big.NewInt(1))
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ca, key, _, err := readCA(pki)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	der, err := x509.CreateRevocationList(rand.Reader, &x509.RevocationList{Number: number, ThisUpdate: now, NextUpdate: now.Add(7 * 24 * time.Hour), RevokedCertificateEntries: entries}, ca, key)
	if err != nil {
		return err
	}
	return atomicWrite(pki, "crl.pem", pem.EncodeToMemory(&pem.Block{Type: "X509 CRL", Bytes: der}), 0644)
}

func validateCRL(pki string, mode os.FileMode) error {
	if mode != 0644 {
		return errors.New("invalid crl mode")
	}
	ca, _, _, err := readCA(pki)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(filepath.Join(pki, "crl.pem"))
	if err != nil {
		return err
	}
	block, rest := pem.Decode(raw)
	if block == nil || block.Type != "X509 CRL" || len(bytes.TrimSpace(rest)) != 0 {
		return errors.New("invalid crl")
	}
	list, err := x509.ParseRevocationList(block.Bytes)
	if err != nil || list.CheckSignatureFrom(ca) != nil {
		return errors.New("invalid crl signature")
	}
	return nil
}
