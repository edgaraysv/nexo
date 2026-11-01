package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"nexo.local/agent/internal/clientipc"
	"nexo.local/agent/internal/vpnruntime"
)

type persistedServiceStatus struct {
	LastConnection string `json:"last_connection,omitempty"`
	LastDiagnostic string `json:"last_diagnostic,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type clientCertificateStatus struct {
	Serial   string `json:"serial,omitempty"`
	NotAfter string `json:"not_after,omitempty"`
	Status   string `json:"status"`
}

type clientVPNEnvironment struct {
	ID              string               `json:"id"`
	Name            string               `json:"name"`
	Engine          string               `json:"engine"`
	Protocol        string               `json:"protocol"`
	ListenerPort    int                  `json:"listener_port"`
	Revision        int64                `json:"revision"`
	ServerPublicKey string               `json:"server_public_key,omitempty"`
	WireGuardPeer   *clientWireGuardPeer `json:"wireguard_peer,omitempty"`
	WireGuardState  string               `json:"wireguard_state,omitempty"`
	CredentialState string               `json:"credential_state,omitempty"`
	ConnectionState string               `json:"connection_state,omitempty"`
	ConnectionError string               `json:"connection_error,omitempty"`
}

type clientVPNCatalog struct {
	ModuleState string                 `json:"module_state"`
	Items       []clientVPNEnvironment `json:"items"`
}

type clientVPNStatus struct {
	State        string                 `json:"state"`
	Environments []clientVPNEnvironment `json:"environments"`
}

type clientStatus struct {
	Service         string                  `json:"service"`
	DeviceID        string                  `json:"device_id,omitempty"`
	Audience        string                  `json:"audience,omitempty"`
	Enrollment      string                  `json:"enrollment"`
	Certificate     clientCertificateStatus `json:"certificate"`
	LastConnection  string                  `json:"last_connection,omitempty"`
	LastDiagnostic  string                  `json:"last_diagnostic,omitempty"`
	LastError       string                  `json:"last_error,omitempty"`
	AgentVersion    string                  `json:"agent_version"`
	OperatingSystem string                  `json:"operating_system"`
	Architecture    string                  `json:"architecture"`
	Modules         map[string]string       `json:"modules"`
	VPN             clientVPNStatus         `json:"vpn"`
}

type serviceRuntime struct {
	base         string
	dir          string
	key          *ecdsa.PrivateKey
	mu           sync.Mutex
	nextMutation time.Time
	vpn          *managedVPNRuntime
	routeCheck   func(netip.Addr) (bool, error)
}

func runService(base, dir, endpoint, allowedSID string, key *ecdsa.PrivateKey) error {
	return runServiceUntil(base, dir, endpoint, allowedSID, key, nil)
}

func runServiceUntil(base, dir, endpoint, allowedSID string, key *ecdsa.PrivateKey, stop <-chan struct{}) error {
	if current, stateError := readState(dir); stateError == nil && current.Audience != "endpoint" {
		return errors.New("windows client service requires endpoint identity")
	} else if stateError != nil && !errors.Is(stateError, os.ErrNotExist) {
		return errors.New("endpoint state unavailable")
	}
	listener, err := clientipc.Listen(endpoint, allowedSID)
	if err != nil {
		return err
	}
	defer listener.Close()
	service := &serviceRuntime{base: base, dir: dir, key: key}
	if launcher, launcherError := newPlatformVPNLauncher(); launcherError == nil {
		service.vpn, err = newManagedVPNRuntime(base, dir, launcher)
		if err != nil {
			service.recordError("vpn_runtime_unavailable")
		}
	} else if runtime.GOOS == "windows" {
		service.recordError("vpn_runtime_unavailable")
	}
	defer func() {
		if service.vpn != nil {
			service.vpn.shutdown()
		}
	}()
	go service.poll(stop)
	done := make(chan error, 1)
	go func() { done <- clientipc.Serve(listener, service) }()
	if stop == nil {
		return <-done
	}
	select {
	case err = <-done:
		return err
	case <-stop:
		_ = listener.Close()
		return <-done
	}
}

func (service *serviceRuntime) Handle(_ context.Context, request clientipc.Request) (any, string) {
	service.mu.Lock()
	defer service.mu.Unlock()
	switch request.Action {
	case "status", "diagnostics":
		if !emptyPayload(request.Payload) {
			return nil, "invalid_payload"
		}
		return service.status(), ""
	case "enroll":
		var payload struct {
			Token string `json:"token"`
			Name  string `json:"name"`
		}
		if !decodePayload(request.Payload, &payload) || len(payload.Token) < 20 || len(payload.Token) > 512 || len(strings.TrimSpace(payload.Name)) < 1 || len(payload.Name) > 160 {
			return nil, "invalid_payload"
		}
		if time.Now().Before(service.nextMutation) {
			return nil, "rate_limited"
		}
		service.nextMutation = time.Now().Add(2 * time.Second)
		if _, err := readState(service.dir); err == nil {
			return nil, "already_enrolled"
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, "state_unavailable"
		}
		if err := enroll(service.base, service.dir, service.key, payload.Token, strings.TrimSpace(payload.Name), "endpoint", io.Discard); err != nil {
			service.recordError("enrollment_failed")
			return nil, "enrollment_failed"
		}
		service.clearError()
		return service.status(), ""
	case "claim":
		if !emptyPayload(request.Payload) {
			return nil, "invalid_payload"
		}
		if time.Now().Before(service.nextMutation) {
			return nil, "rate_limited"
		}
		service.nextMutation = time.Now().Add(2 * time.Second)
		if err := claim(service.base, service.dir, io.Discard); err != nil {
			service.recordError("claim_failed")
			return nil, "claim_failed"
		}
		service.clearError()
		return service.status(), ""
	case "run_diagnostic":
		if !emptyPayload(request.Payload) {
			return nil, "invalid_payload"
		}
		if time.Now().Before(service.nextMutation) {
			return nil, "rate_limited"
		}
		service.nextMutation = time.Now().Add(10 * time.Second)
		if err := service.runOnce(); err != nil {
			return nil, "control_unavailable"
		}
		return service.status(), ""
	case "revoke_vpn_credential":
		var payload struct {
			EnvironmentID string `json:"environment_id"`
		}
		if !decodePayload(request.Payload, &payload) || !vpnruntime.ValidEnvironmentID(payload.EnvironmentID) {
			return nil, "invalid_payload"
		}
		if time.Now().Before(service.nextMutation) {
			return nil, "rate_limited"
		}
		service.nextMutation = time.Now().Add(2 * time.Second)
		if service.vpn != nil {
			_ = service.vpn.disconnect(payload.EnvironmentID)
		}
		if err := service.revokeVPNCredential(payload.EnvironmentID); err != nil {
			service.recordError("vpn_revocation_failed")
			return nil, "vpn_revocation_failed"
		}
		return service.status(), ""
	case "connect_vpn", "disconnect_vpn", "rotate_wireguard_peer":
		var payload struct {
			EnvironmentID string `json:"environment_id"`
		}
		if !decodePayload(request.Payload, &payload) || !vpnruntime.ValidEnvironmentID(payload.EnvironmentID) {
			return nil, "invalid_payload"
		}
		if service.vpn == nil {
			if request.Action != "rotate_wireguard_peer" {
				return nil, "vpn_runtime_unavailable"
			}
		}
		if time.Now().Before(service.nextMutation) {
			return nil, "rate_limited"
		}
		service.nextMutation = time.Now().Add(2 * time.Second)
		if request.Action == "disconnect_vpn" {
			if err := service.vpn.disconnect(payload.EnvironmentID); err != nil {
				return nil, "vpn_disconnect_failed"
			}
			return service.status(), ""
		}
		if request.Action == "rotate_wireguard_peer" {
			environment, err := service.connectableVPNEnvironment(payload.EnvironmentID)
			if err != nil || environment.Engine != "wireguard" {
				return nil, "vpn_unavailable"
			}
			if err = service.requestWireGuardRotation(environment.ID); err != nil {
				service.recordError("wireguard_rotation_failed")
				return nil, "wireguard_rotation_failed"
			}
			return service.status(), ""
		}
		environment, err := service.connectableVPNEnvironment(payload.EnvironmentID)
		if err != nil {
			return nil, "vpn_unavailable"
		}
		if err = service.vpn.connect(environment); err != nil {
			service.recordError("vpn_start_failed")
			return nil, "vpn_start_failed"
		}
		return service.status(), ""
	default:
		return nil, "unsupported_action"
	}
}

func (service *serviceRuntime) poll(stop <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		service.mu.Lock()
		state, err := readState(service.dir)
		if err == nil && state.Serial != "" {
			_ = service.runOnce()
		}
		service.mu.Unlock()
		if stop == nil {
			<-ticker.C
			continue
		}
		select {
		case <-ticker.C:
		case <-stop:
			return
		}
	}
}

func (service *serviceRuntime) runOnce() error {
	err := runOnce(service.base, service.dir, service.key, io.Discard)
	status := service.readPersisted()
	if err != nil {
		status.LastError = "control_unavailable"
	} else {
		err = service.syncVPNCatalog()
	}
	if err != nil {
		if service.vpn != nil {
			service.vpn.failClosed("control_unavailable")
		}
		if status.LastError == "" {
			status.LastError = "vpn_catalog_unavailable"
		}
	} else {
		now := time.Now().UTC().Format(time.RFC3339)
		status.LastConnection = now
		status.LastDiagnostic = now
		status.LastError = ""
		// F08 observation is independent of the VPN transport. A missing
		// private-network catalog must not fail-close an otherwise healthy VPN.
		if networkError := service.syncPrivateNetworks(); networkError != nil {
			status.LastError = "private_network_unavailable"
		}
	}
	_ = service.writePersisted(status)
	return err
}

func (service *serviceRuntime) status() clientStatus {
	persisted := service.readPersisted()
	result := clientStatus{
		Service: "running", Enrollment: "unregistered",
		Certificate:    clientCertificateStatus{Status: "missing"},
		LastConnection: persisted.LastConnection, LastDiagnostic: persisted.LastDiagnostic, LastError: persisted.LastError,
		AgentVersion: "0.1.0", OperatingSystem: runtime.GOOS, Architecture: runtime.GOARCH,
		Modules: map[string]string{"control": "enabled", "vpn": "not_integrated", "support": "not_integrated", "backup": "not_integrated"},
		VPN:     clientVPNStatus{State: "unavailable", Environments: []clientVPNEnvironment{}},
	}
	state, err := readState(service.dir)
	if err != nil {
		return result
	}
	result.DeviceID, result.Audience = state.DeviceID, state.Audience
	result.Enrollment = "pending_approval"
	if state.Serial == "" {
		return result
	}
	result.Enrollment = "approved"
	result.Certificate = certificateStatus(state)
	if catalog, catalogError := service.readVPNCatalog(); catalogError == nil {
		if catalog.ModuleState == "enabled" {
			result.Modules["vpn"] = "enabled"
		}
		result.VPN.Environments = catalog.Items
		for index := range result.VPN.Environments {
			if result.VPN.Environments[index].Engine == "openvpn" {
				result.VPN.Environments[index].CredentialState = service.readVPNCredentialStatus(result.VPN.Environments[index].ID).State
			}
			if service.vpn != nil {
				connection := service.vpn.connection(result.VPN.Environments[index].ID)
				result.VPN.Environments[index].ConnectionState = string(connection.State)
				result.VPN.Environments[index].ConnectionError = connection.LastError
			}
		}
		if catalog.ModuleState == "enabled" && len(catalog.Items) > 0 {
			result.VPN.State = "catalog_ready"
			for _, environment := range result.VPN.Environments {
				switch environment.ConnectionState {
				case string(vpnConnected):
					result.VPN.State = "connected"
				case string(vpnConfigured):
					if result.VPN.State != "connected" {
						result.VPN.State = "configured"
					}
				case string(vpnConnecting):
					if result.VPN.State != "connected" {
						result.VPN.State = "connecting"
					}
				case string(vpnError):
					if result.VPN.State != "connected" && result.VPN.State != "connecting" {
						result.VPN.State = "error"
					}
				case string(vpnDisconnected):
					if result.VPN.State == "catalog_ready" && environment.CredentialState == "issued" {
						result.VPN.State = "disconnected"
					}
				}
			}
		}
	}
	return result
}

func (service *serviceRuntime) syncVPNCatalog() error {
	current, session, err := authenticateSession(service.base, service.dir, service.key)
	if err != nil || current.Audience != "endpoint" {
		return errors.New("endpoint authentication required")
	}
	token, ok := session["token"].(string)
	if !ok {
		return errors.New("missing device session")
	}
	var catalog clientVPNCatalog
	if err = postWithToken(service.base, "/v1/device/vpn/reconcile", map[string]any{}, &catalog, token); err != nil {
		return err
	}
	if err = validateVPNCatalog(catalog); err != nil {
		return err
	}
	if err = service.syncVPNCredentials(catalog, token); err != nil {
		return err
	}
	if err = service.syncWireGuardPeers(&catalog, token); err != nil {
		return err
	}
	// Environments absent from the catalog are not treated as withdrawn. The
	// authenticated credential endpoint is the explicit source of a revocation
	// for credentials the device already holds.
	if err = service.resolveAbsentVPNCredentials(catalog, token); err != nil {
		return err
	}
	if service.vpn != nil {
		if err = service.vpn.reconcile(catalog, service.readVPNCredentialStatus); err != nil {
			return err
		}
	}
	return service.writeVPNCatalog(catalog)
}

func (service *serviceRuntime) connectableVPNEnvironment(environmentID string) (clientVPNEnvironment, error) {
	catalog, err := service.readVPNCatalog()
	if err != nil || catalog.ModuleState != "enabled" {
		return clientVPNEnvironment{}, errors.New("vpn catalog unavailable")
	}
	for _, environment := range catalog.Items {
		if environment.ID != environmentID {
			continue
		}
		if environment.Engine == "openvpn" && service.readVPNCredentialStatus(environmentID).State == "issued" {
			return environment, nil
		}
		if environment.Engine == "wireguard" && environment.WireGuardPeer != nil {
			if _, err := wireGuardClientKeyForPeer(service.dir, environment.ID, environment.WireGuardPeer.ClientPublicKey); err == nil {
				return environment, nil
			}
		}
	}
	return clientVPNEnvironment{}, errors.New("vpn environment unavailable")
}

func validateVPNCatalog(catalog clientVPNCatalog) error {
	if catalog.ModuleState != "enabled" && catalog.ModuleState != "disabled" {
		return errors.New("invalid vpn module state")
	}
	if catalog.ModuleState == "disabled" && len(catalog.Items) != 0 || len(catalog.Items) > 32 {
		return errors.New("invalid vpn catalog")
	}
	seen := map[string]struct{}{}
	for _, item := range catalog.Items {
		if !vpnruntime.ValidEnvironmentID(item.ID) || len(strings.TrimSpace(item.Name)) < 1 || len(item.Name) > 120 || item.Engine != "openvpn" && item.Engine != "wireguard" || item.Protocol != "udp" || item.ListenerPort < 1024 || item.ListenerPort > 65535 || item.Revision < 1 {
			return errors.New("invalid vpn environment")
		}
		if item.Engine == "openvpn" && (item.ServerPublicKey != "" || item.WireGuardPeer != nil || item.WireGuardState != "") || item.Engine == "wireguard" && !validWireGuardClientKey(item.ServerPublicKey) {
			return errors.New("invalid wireguard environment")
		}
		if item.WireGuardPeer != nil && !validClientWireGuardPeer(item) {
			return errors.New("invalid wireguard peer configuration")
		}
		if item.WireGuardState != "" && !map[string]bool{"pending_approval": true, "active": true, "awaiting_node_key": true, "unavailable": true}[item.WireGuardState] {
			return errors.New("invalid wireguard peer state")
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return errors.New("duplicate vpn environment")
		}
		seen[item.ID] = struct{}{}
	}
	return nil
}

func (service *serviceRuntime) readVPNCatalog() (clientVPNCatalog, error) {
	var catalog clientVPNCatalog
	raw, err := os.ReadFile(filepath.Join(service.dir, "vpn-catalog.json"))
	if err != nil {
		return catalog, err
	}
	if err = json.Unmarshal(raw, &catalog); err != nil {
		return catalog, err
	}
	return catalog, validateVPNCatalog(catalog)
}

func (service *serviceRuntime) writeVPNCatalog(catalog clientVPNCatalog) error {
	if err := os.MkdirAll(service.dir, 0700); err != nil {
		return err
	}
	raw, _ := json.Marshal(catalog)
	path := filepath.Join(service.dir, "vpn-catalog.json")
	temporary := path + ".new"
	if err := os.WriteFile(temporary, raw, 0600); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, path)
}

func certificateStatus(state state) clientCertificateStatus {
	result := clientCertificateStatus{Serial: state.Serial, Status: "invalid"}
	block, _ := pem.Decode([]byte(state.CertificatePEM))
	if block == nil {
		return result
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return result
	}
	result.NotAfter = certificate.NotAfter.UTC().Format(time.RFC3339)
	if time.Now().After(certificate.NotAfter) {
		result.Status = "expired"
	} else if time.Now().Before(certificate.NotBefore) {
		result.Status = "not_yet_valid"
	} else {
		result.Status = "active"
	}
	return result
}

func (service *serviceRuntime) recordError(code string) {
	status := service.readPersisted()
	status.LastError = code
	_ = service.writePersisted(status)
}

func (service *serviceRuntime) clearError() {
	status := service.readPersisted()
	status.LastError = ""
	_ = service.writePersisted(status)
}

func (service *serviceRuntime) readPersisted() persistedServiceStatus {
	var status persistedServiceStatus
	raw, err := os.ReadFile(filepath.Join(service.dir, "service-status.json"))
	if err == nil {
		_ = json.Unmarshal(raw, &status)
	}
	return status
}

func (service *serviceRuntime) writePersisted(status persistedServiceStatus) error {
	if err := os.MkdirAll(service.dir, 0700); err != nil {
		return err
	}
	raw, _ := json.Marshal(status)
	return os.WriteFile(filepath.Join(service.dir, "service-status.json"), raw, 0600)
}

func emptyPayload(payload json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(payload))
	return trimmed == "" || trimmed == "null" || trimmed == "{}"
}

func decodePayload(payload json.RawMessage, target any) bool {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return false
	}
	var trailing any
	return errors.Is(decoder.Decode(&trailing), io.EOF)
}
