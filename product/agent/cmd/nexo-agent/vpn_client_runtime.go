package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"nexo.local/agent/internal/keystore"
	"nexo.local/agent/internal/vpnruntime"
)

type vpnConnectionState string

const (
	vpnDisconnected vpnConnectionState = "disconnected"
	vpnConnecting   vpnConnectionState = "connecting"
	vpnConnected    vpnConnectionState = "connected"
	vpnConfigured   vpnConnectionState = "configured"
	vpnError        vpnConnectionState = "error"
)

type vpnConnectionRecord struct {
	EnvironmentID     string             `json:"environment_id"`
	Engine            string             `json:"engine,omitempty"`
	Desired           bool               `json:"desired"`
	State             vpnConnectionState `json:"state"`
	LastError         string             `json:"last_error,omitempty"`
	ConfigFingerprint string             `json:"config_fingerprint,omitempty"`
}

type vpnProcess interface{ Stop() error }
type vpnLauncher interface {
	Start(configPath string, onLine func(string), onExit func(error)) (vpnProcess, error)
}
type vpnEnvironmentCleaner interface {
	StopEnvironment(environmentID string) error
}

type managedVPNRuntime struct {
	mu         sync.Mutex
	base       string
	remoteHost string
	dir        string
	launcher   vpnLauncher
	records    map[string]vpnConnectionRecord
	processes  map[string]vpnProcess
	generation map[string]uint64
	retryAt    map[string]time.Time
}

var managedHostLabelPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

func newManagedVPNRuntime(base, dir string, launcher vpnLauncher) (*managedVPNRuntime, error) {
	if launcher == nil {
		return nil, errors.New("vpn launcher unavailable")
	}
	remoteHost, err := managedVPNHost(base)
	if err != nil {
		return nil, err
	}
	if override, present := os.LookupEnv("NEXO_VPN_REMOTE_HOST"); present {
		if override == "" || strings.TrimSpace(override) != override || !validManagedVPNHost(override) {
			return nil, errors.New("invalid managed vpn host override")
		}
		remoteHost = override
	}
	runtime := &managedVPNRuntime{base: base, remoteHost: remoteHost, dir: dir, launcher: launcher, records: map[string]vpnConnectionRecord{}, processes: map[string]vpnProcess{}, generation: map[string]uint64{}, retryAt: map[string]time.Time{}}
	raw, err := os.ReadFile(runtime.statePath())
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	} else if err != nil || json.Unmarshal(raw, &runtime.records) != nil || runtime.records == nil {
		return nil, errors.New("vpn runtime state unavailable")
	}
	if runtime.records == nil {
		runtime.records = map[string]vpnConnectionRecord{}
	}
	for id, record := range runtime.records {
		if !vpnruntime.ValidEnvironmentID(id) || record.EnvironmentID != id || record.Engine != "" && record.Engine != "openvpn" && record.Engine != "wireguard" || !map[vpnConnectionState]bool{vpnDisconnected: true, vpnConnecting: true, vpnConnected: true, vpnConfigured: true, vpnError: true}[record.State] {
			return nil, errors.New("invalid vpn runtime state")
		}
		if record.Engine == "wireguard" {
			cleaner, ok := launcher.(vpnEnvironmentCleaner)
			if !ok {
				return nil, errors.New("vpn service cleanup unavailable")
			}
			if err := cleaner.StopEnvironment(id); err != nil {
				return nil, errors.New("vpn service cleanup failed")
			}
		}
	}
	if err := runtime.cleanupStaleTransient(); err != nil {
		return nil, errors.New("vpn transient cleanup failed")
	}
	if len(runtime.records) == 0 {
		return runtime, nil
	}
	for id, record := range runtime.records {
		record.State = vpnDisconnected
		record.LastError = ""
		runtime.records[id] = record
	}
	if err = runtime.persistLocked(); err != nil {
		return nil, err
	}
	return runtime, nil
}

func managedVPNHost(base string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.User != nil || parsed.Hostname() == "" {
		return "", errors.New("invalid managed vpn host")
	}
	host := parsed.Hostname()
	if !validManagedVPNHost(host) {
		return "", errors.New("invalid managed vpn host")
	}
	return host, nil
}

func validManagedVPNHost(host string) bool {
	if net.ParseIP(host) != nil {
		return true
	}
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if !managedHostLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}

func (runtime *managedVPNRuntime) connect(environment clientVPNEnvironment) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for id, record := range runtime.records {
		if id != environment.ID && record.Desired {
			if err := runtime.stopLocked(id, false, ""); err != nil {
				return err
			}
		}
	}
	record := runtime.records[environment.ID]
	record.EnvironmentID, record.Engine, record.Desired, record.State, record.LastError = environment.ID, environment.Engine, true, vpnConnecting, ""
	runtime.records[environment.ID] = record
	if err := runtime.persistLocked(); err != nil {
		return err
	}
	return runtime.startLocked(environment)
}

func (runtime *managedVPNRuntime) disconnect(environmentID string) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if _, exists := runtime.records[environmentID]; !exists {
		return errors.New("vpn connection unavailable")
	}
	stopError := runtime.stopLocked(environmentID, false, "")
	return errors.Join(stopError, runtime.persistLocked())
}

func (runtime *managedVPNRuntime) reconcile(catalog clientVPNCatalog, credentials func(string) localVPNCredential) error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	allowed := map[string]clientVPNEnvironment{}
	if catalog.ModuleState == "enabled" {
		for _, environment := range catalog.Items {
			allowed[environment.ID] = environment
		}
	}
	for id := range runtime.records {
		credential := credentials(id)
		_, offered := allowed[id]
		usable := offered && usableVPNEnvironment(allowed[id], credential)
		if usable {
			continue
		}
		// Explicit revocation cancels the connection intent and the credential
		// material is removed by the control-plane sync. A transient catalog
		// absence (or control failure) only fails closed: the process stops but
		// the credential and the intent survive so the connection can resume.
		revoked := allowed[id].Engine == "openvpn" && (credential.State == "revoked" || credential.State == "revocation_pending")
		code := "credential_unavailable"
		if offered && allowed[id].Engine == "wireguard" {
			code = "wireguard_peer_unavailable"
		}
		if !offered && !revoked {
			code = "environment_unavailable"
		}
		_ = runtime.stopLocked(id, !revoked, code)
	}
	for id, environment := range allowed {
		record := runtime.records[id]
		if !record.Desired {
			continue
		}
		if !usableVPNEnvironment(environment, credentials(id)) {
			continue
		}
		if runtime.processes[id] != nil && record.ConfigFingerprint != vpnConfigFingerprint(environment) {
			if err := runtime.stopLocked(id, true, ""); err != nil {
				runtime.retryAt[id] = time.Now().Add(30 * time.Second)
				continue
			}
			record = runtime.records[id]
		}
		if runtime.processes[id] != nil || time.Now().Before(runtime.retryAt[id]) {
			continue
		}
		if err := runtime.startLocked(environment); err != nil {
			record = runtime.records[id]
			record.State, record.LastError = vpnError, "vpn_start_failed"
			runtime.records[id] = record
			runtime.retryAt[id] = time.Now().Add(30 * time.Second)
		}
	}
	return runtime.persistLocked()
}

func (runtime *managedVPNRuntime) failClosed(code string) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for id, record := range runtime.records {
		if record.Desired || runtime.processes[id] != nil {
			_ = runtime.stopLocked(id, true, code)
		}
	}
	_ = runtime.persistLocked()
}

func (runtime *managedVPNRuntime) shutdown() {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for id := range runtime.processes {
		_ = runtime.stopLocked(id, true, "")
	}
	_ = runtime.persistLocked()
}

func (runtime *managedVPNRuntime) connection(environmentID string) vpnConnectionRecord {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if record, exists := runtime.records[environmentID]; exists {
		return record
	}
	return vpnConnectionRecord{EnvironmentID: environmentID, State: vpnDisconnected}
}

func (runtime *managedVPNRuntime) startLocked(environment clientVPNEnvironment) error {
	if runtime.processes[environment.ID] != nil {
		return nil
	}
	configPath, err := runtime.prepare(environment)
	if err != nil {
		runtime.setErrorLocked(environment.ID, "credential_invalid")
		return err
	}
	runtime.generation[environment.ID]++
	generation := runtime.generation[environment.ID]
	process, err := runtime.launcher.Start(configPath, func(line string) { runtime.observe(environment.ID, generation, line) }, func(waitError error) { runtime.exited(environment.ID, generation, waitError) })
	if err != nil {
		_ = runtime.removeTransient(environment.ID)
		runtime.setErrorLocked(environment.ID, "vpn_start_failed")
		return err
	}
	runtime.processes[environment.ID] = process
	record := runtime.records[environment.ID]
	state := vpnConnecting
	if environment.Engine == "wireguard" {
		// Installation of the native tunnel service proves configuration was
		// accepted; it does not prove a handshake or application reachability.
		state = vpnConfigured
	}
	record.EnvironmentID, record.Engine, record.Desired, record.State, record.LastError = environment.ID, environment.Engine, true, state, ""
	record.ConfigFingerprint = vpnConfigFingerprint(environment)
	runtime.records[environment.ID] = record
	return runtime.persistLocked()
}

func (runtime *managedVPNRuntime) prepare(environment clientVPNEnvironment) (string, error) {
	if environment.Engine == "wireguard" {
		if !validClientWireGuardPeer(environment) {
			return "", errors.New("wireguard peer unavailable")
		}
		key, err := wireGuardClientKeyForPeer(runtime.dir, environment.ID, environment.WireGuardPeer.ClientPublicKey)
		if err != nil {
			return "", err
		}
		config, err := renderManagedWireGuard(environment, runtime.remoteHost, key)
		if err != nil {
			return "", err
		}
		runtimeDirectory := filepath.Join(runtime.dir, "vpn", environment.ID, "runtime")
		if err = os.MkdirAll(runtimeDirectory, 0700); err != nil {
			return "", err
		}
		configPath := filepath.Join(runtimeDirectory, "nexo-"+strings.ReplaceAll(environment.ID, "-", "")+".conf")
		if err = writePrivateFile(configPath, []byte(config), 0600); err != nil {
			return "", err
		}
		return configPath, nil
	}
	if !managedEnvironment(environment) {
		return "", errors.New("invalid managed vpn environment")
	}
	credential := (&serviceRuntime{dir: runtime.dir}).readVPNCredentialStatus(environment.ID)
	if credential.State != "issued" || credential.NotAfter == "" || time.Now().After(parseTime(credential.NotAfter)) {
		return "", errors.New("vpn credential unavailable")
	}
	directory := filepath.Join(runtime.dir, "vpn", environment.ID)
	keyPathPersisted := filepath.Join(directory, "client.key")
	if _, err := os.Stat(keyPathPersisted); err != nil {
		return "", errors.New("vpn private key unavailable")
	}
	key, err := keystore.LoadOrCreate(keyPathPersisted)
	if err != nil {
		return "", err
	}
	certificatePEM, err := os.ReadFile(filepath.Join(directory, "client.crt"))
	if err != nil {
		return "", err
	}
	caPEM, err := os.ReadFile(filepath.Join(directory, "ca.crt"))
	if err != nil {
		return "", err
	}
	envelope, err := os.ReadFile(filepath.Join(directory, "tls-crypt.envelope"))
	if err != nil {
		return "", errors.New("vpn tls crypt key unavailable")
	}
	tlsCryptKey, err := vpnruntime.DecryptTLSCryptKey(key, environment.ID, string(envelope))
	if err != nil {
		return "", errors.New("invalid vpn tls crypt key")
	}
	certificate, ca, err := validateRuntimeCertificate(certificatePEM, caPEM, key)
	if err != nil || !sameCredentialSerial(certificate.SerialNumber, credential.Serial) || time.Now().Before(certificate.NotBefore) || time.Now().After(certificate.NotAfter) {
		return "", errors.New("invalid vpn credential")
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	runtimeDirectory := filepath.Join(directory, "runtime")
	if err = os.MkdirAll(runtimeDirectory, 0700); err != nil {
		return "", err
	}
	keyPath := filepath.Join(runtimeDirectory, "client.key")
	if err = writePrivateFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
		return "", err
	}
	tlsCryptPath := filepath.Join(runtimeDirectory, "tls-crypt.key")
	if err = writePrivateFile(tlsCryptPath, tlsCryptKey, 0600); err != nil {
		_ = os.Remove(keyPath)
		return "", err
	}
	config, err := renderManagedOpenVPN(environment, runtime.remoteHost, filepath.Join(directory, "ca.crt"), filepath.Join(directory, "client.crt"), keyPath, tlsCryptPath)
	if err != nil {
		_ = os.Remove(keyPath)
		_ = os.Remove(tlsCryptPath)
		return "", err
	}
	configPath := filepath.Join(runtimeDirectory, "client.ovpn")
	if err = writePrivateFile(configPath, []byte(config), 0600); err != nil {
		_ = os.Remove(keyPath)
		_ = os.Remove(tlsCryptPath)
		return "", err
	}
	_ = ca
	return configPath, nil
}

// sameCredentialSerial compares the certificate serial with the control-plane
// value numerically. The issuer may omit leading zeroes in one representation,
// so comparing hexadecimal strings directly rejects valid credentials.
func sameCredentialSerial(certificateSerial *big.Int, credentialSerial string) bool {
	if certificateSerial == nil || certificateSerial.Sign() <= 0 {
		return false
	}
	parsed, ok := new(big.Int).SetString(credentialSerial, 16)
	return ok && parsed.Sign() > 0 && certificateSerial.Cmp(parsed) == 0
}

func validateRuntimeCertificate(certificatePEM, caPEM []byte, key *ecdsa.PrivateKey) (*x509.Certificate, *x509.Certificate, error) {
	certificateBlock, certificateRest := pem.Decode(certificatePEM)
	caBlock, caRest := pem.Decode(caPEM)
	if certificateBlock == nil || certificateBlock.Type != "CERTIFICATE" || len(bytes.TrimSpace(certificateRest)) != 0 || caBlock == nil || caBlock.Type != "CERTIFICATE" || len(bytes.TrimSpace(caRest)) != 0 {
		return nil, nil, errors.New("invalid vpn certificate pem")
	}
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	ca, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil || !ca.IsCA || certificate.CheckSignatureFrom(ca) != nil {
		return nil, nil, errors.New("invalid vpn certificate chain")
	}
	clientAuth := false
	for _, usage := range certificate.ExtKeyUsage {
		clientAuth = clientAuth || usage == x509.ExtKeyUsageClientAuth
	}
	left, leftError := x509.MarshalPKIXPublicKey(certificate.PublicKey)
	right, rightError := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if !clientAuth || leftError != nil || rightError != nil || !bytes.Equal(left, right) {
		return nil, nil, errors.New("invalid vpn client identity")
	}
	return certificate, ca, nil
}

func renderManagedOpenVPN(environment clientVPNEnvironment, host, caPath, certificatePath, keyPath, tlsCryptPath string) (string, error) {
	if !managedEnvironment(environment) || !validManagedVPNHost(host) {
		return "", errors.New("invalid managed vpn configuration")
	}
	path := func(value string) (string, error) {
		value = filepath.ToSlash(value)
		if strings.ContainsAny(value, "\r\n\"") || !filepath.IsAbs(filepath.FromSlash(value)) {
			return "", errors.New("invalid managed vpn path")
		}
		return `"` + value + `"`, nil
	}
	ca, err := path(caPath)
	if err != nil {
		return "", err
	}
	certificate, err := path(certificatePath)
	if err != nil {
		return "", err
	}
	key, err := path(keyPath)
	if err != nil {
		return "", err
	}
	tlsCrypt, err := path(tlsCryptPath)
	if err != nil {
		return "", err
	}
	lines := []string{"client", "dev tun", "proto udp", fmt.Sprintf("remote %s %d", host, environment.ListenerPort), "resolv-retry infinite", "nobind", "persist-key", "remote-cert-tls server", "verify-x509-name " + environment.ID + " name", "tls-version-min 1.2", "tls-cert-profile preferred", "data-ciphers AES-256-GCM:AES-128-GCM", "auth SHA256", "auth-nocache", `pull-filter ignore "redirect-gateway"`, "script-security 1", "verb 3", "tls-crypt " + tlsCrypt, "ca " + ca, "cert " + certificate, "key " + key}
	return strings.Join(lines, "\n") + "\n", nil
}

func managedEnvironment(environment clientVPNEnvironment) bool {
	return vpnruntime.ValidEnvironmentID(environment.ID) && environment.Engine == "openvpn" && environment.Protocol == "udp" && environment.ListenerPort >= 1024 && environment.ListenerPort <= 65535 && environment.Revision > 0
}

func usableVPNEnvironment(environment clientVPNEnvironment, credential localVPNCredential) bool {
	switch environment.Engine {
	case "openvpn":
		return credential.State == "issued" && credential.NotAfter != "" && !time.Now().After(parseTime(credential.NotAfter))
	case "wireguard":
		return validClientWireGuardPeer(environment)
	default:
		return false
	}
}

func vpnConfigFingerprint(environment clientVPNEnvironment) string {
	value := struct {
		ID              string               `json:"id"`
		Engine          string               `json:"engine"`
		Protocol        string               `json:"protocol"`
		ListenerPort    int                  `json:"listener_port"`
		Revision        int64                `json:"revision"`
		ServerPublicKey string               `json:"server_public_key,omitempty"`
		WireGuardPeer   *clientWireGuardPeer `json:"wireguard_peer,omitempty"`
	}{environment.ID, environment.Engine, environment.Protocol, environment.ListenerPort, environment.Revision, environment.ServerPublicKey, environment.WireGuardPeer}
	raw, _ := json.Marshal(value)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func (runtime *managedVPNRuntime) observe(environmentID string, generation uint64, line string) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.generation[environmentID] != generation {
		return
	}
	record := runtime.records[environmentID]
	if strings.Contains(line, "Initialization Sequence Completed") {
		keyPath := filepath.Join(runtime.dir, "vpn", environmentID, "runtime", "client.key")
		tlsCryptPath := filepath.Join(runtime.dir, "vpn", environmentID, "runtime", "tls-crypt.key")
		if err := errors.Join(os.Remove(keyPath), os.Remove(tlsCryptPath)); err != nil && !errors.Is(err, os.ErrNotExist) {
			_ = runtime.stopLocked(environmentID, false, "transient_key_cleanup_failed")
		} else {
			record.State, record.LastError = vpnConnected, ""
			runtime.records[environmentID] = record
		}
	} else if strings.Contains(line, "AUTH_FAILED") || strings.Contains(line, "TLS Error") || strings.Contains(line, "Options error") || strings.Contains(line, "fatal error") {
		record.State, record.LastError = vpnError, "vpn_connection_failed"
		runtime.records[environmentID] = record
	}
	_ = runtime.persistLocked()
}

func (runtime *managedVPNRuntime) exited(environmentID string, generation uint64, _ error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.generation[environmentID] != generation {
		return
	}
	delete(runtime.processes, environmentID)
	delete(runtime.generation, environmentID)
	_ = runtime.removeTransient(environmentID)
	record := runtime.records[environmentID]
	record.ConfigFingerprint = ""
	if record.Desired {
		record.State, record.LastError = vpnError, "vpn_process_exited"
		runtime.retryAt[environmentID] = time.Now().Add(30 * time.Second)
	} else {
		record.State, record.LastError = vpnDisconnected, ""
	}
	runtime.records[environmentID] = record
	_ = runtime.persistLocked()
}

func (runtime *managedVPNRuntime) stopLocked(environmentID string, preserveDesired bool, code string) error {
	runtime.generation[environmentID]++
	var stopError error
	if process := runtime.processes[environmentID]; process != nil {
		stopError = process.Stop()
		if stopError == nil {
			delete(runtime.processes, environmentID)
		}
	}
	var cleanupError error
	if stopError == nil {
		cleanupError = runtime.removeTransient(environmentID)
	}
	record := runtime.records[environmentID]
	record.EnvironmentID, record.Desired = environmentID, preserveDesired && record.Desired
	if stopError == nil && cleanupError == nil {
		record.ConfigFingerprint = ""
	}
	if code == "" && (stopError != nil || cleanupError != nil) {
		code = "vpn_cleanup_failed"
	}
	if code != "" {
		record.State, record.LastError = vpnError, code
	} else {
		record.State, record.LastError = vpnDisconnected, ""
	}
	runtime.records[environmentID] = record
	return errors.Join(stopError, cleanupError)
}

func (runtime *managedVPNRuntime) setErrorLocked(environmentID, code string) {
	record := runtime.records[environmentID]
	record.EnvironmentID, record.State, record.LastError = environmentID, vpnError, code
	runtime.records[environmentID] = record
	_ = runtime.persistLocked()
}

func (runtime *managedVPNRuntime) removeTransient(environmentID string) error {
	if !vpnruntime.ValidEnvironmentID(environmentID) {
		return errors.New("invalid vpn environment")
	}
	if runtime.records[environmentID].Engine == "wireguard" {
		cleaner, ok := runtime.launcher.(vpnEnvironmentCleaner)
		if !ok {
			return errors.New("vpn service cleanup unavailable")
		}
		if err := cleaner.StopEnvironment(environmentID); err != nil {
			return err
		}
	}
	directory := filepath.Join(runtime.dir, "vpn", environmentID, "runtime")
	remove := func(path string) error {
		var err error
		for attempt := 0; attempt < 10; attempt++ {
			err = os.Remove(path)
			if err == nil || errors.Is(err, os.ErrNotExist) {
				return nil
			}
			time.Sleep(50 * time.Millisecond)
		}
		return err
	}
	return errors.Join(remove(filepath.Join(directory, "client.key")), remove(filepath.Join(directory, "tls-crypt.key")), remove(filepath.Join(directory, "client.ovpn")), remove(filepath.Join(directory, "client.conf")), remove(filepath.Join(directory, "nexo-"+strings.ReplaceAll(environmentID, "-", "")+".conf")), remove(directory))
}

func (runtime *managedVPNRuntime) cleanupStaleTransient() error {
	root := filepath.Join(runtime.dir, "vpn")
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !vpnruntime.ValidEnvironmentID(entry.Name()) {
			continue
		}
		if err = runtime.removeTransient(entry.Name()); err != nil {
			return err
		}
	}
	return nil
}

func (runtime *managedVPNRuntime) persistLocked() error {
	if err := os.MkdirAll(runtime.dir, 0700); err != nil {
		return err
	}
	ordered := make(map[string]vpnConnectionRecord, len(runtime.records))
	keys := make([]string, 0, len(runtime.records))
	for key := range runtime.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		ordered[key] = runtime.records[key]
	}
	raw, _ := json.Marshal(ordered)
	return writePrivateFile(runtime.statePath(), raw, 0600)
}

func (runtime *managedVPNRuntime) statePath() string {
	return filepath.Join(runtime.dir, "vpn-connections.json")
}
func parseTime(value string) time.Time { parsed, _ := time.Parse(time.RFC3339, value); return parsed }
