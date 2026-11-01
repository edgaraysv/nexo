package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"nexo.local/agent/internal/vpnruntime"
)

type clientWireGuardPeer struct {
	PeerID                     string   `json:"peerId"`
	TunnelIPv4                 string   `json:"tunnelIpv4"`
	ClientPublicKey            string   `json:"clientPublicKey"`
	ServerTunnelIPv4           string   `json:"serverTunnelIpv4"`
	ServerPublicKey            string   `json:"serverPublicKey"`
	ListenerPort               int      `json:"listenerPort"`
	AllowedIPs                 []string `json:"allowedIps"`
	PersistentKeepaliveSeconds int      `json:"persistentKeepaliveSeconds"`
}

type wireGuardRegistrationResponse struct {
	PeerID               string `json:"peerId"`
	State                string `json:"state"`
	TunnelIPv4           string `json:"tunnelIpv4"`
	PublicKeyFingerprint string `json:"publicKeyFingerprint"`
}

type wireGuardLocalKeyState struct {
	ActiveFingerprint  string `json:"active_fingerprint"`
	PendingFingerprint string `json:"pending_fingerprint,omitempty"`
}

func wireGuardClientDirectory(root, environmentID string) (string, error) {
	if !vpnruntime.ValidEnvironmentID(environmentID) {
		return "", errors.New("invalid wireguard environment")
	}
	directory := filepath.Join(root, "vpn", environmentID, "wireguard")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("wireguard key directory unavailable")
	}
	return directory, nil
}

func ensureWireGuardActiveKey(root, environmentID string) (*ecdh.PrivateKey, string, error) {
	directory, err := wireGuardClientDirectory(root, environmentID)
	if err != nil {
		return nil, "", err
	}
	state, err := readWireGuardLocalKeyState(directory)
	if err != nil {
		return nil, "", err
	}
	path := filepath.Join(directory, "client.key")
	key, err := loadWireGuardPrivateKey(path)
	if errors.Is(err, os.ErrNotExist) {
		if state.ActiveFingerprint != "" {
			return nil, "", errors.New("wireguard private key unavailable")
		}
		key, err = createWireGuardPrivateKey(path)
		if errors.Is(err, os.ErrExist) {
			key, err = loadWireGuardPrivateKey(path)
		}
	}
	if err != nil {
		return nil, "", err
	}
	publicKey := wireGuardPublicKey(key)
	fingerprint := wireGuardFingerprint(publicKey)
	if state.ActiveFingerprint != "" && state.ActiveFingerprint != fingerprint {
		return nil, "", errors.New("wireguard private key identity conflict")
	}
	if state.ActiveFingerprint == "" {
		state.ActiveFingerprint = fingerprint
		if err = writeWireGuardLocalKeyState(directory, state); err != nil {
			return nil, "", err
		}
	}
	return key, publicKey, nil
}

func ensureWireGuardPendingKey(root, environmentID string) (*ecdh.PrivateKey, string, error) {
	directory, err := wireGuardClientDirectory(root, environmentID)
	if err != nil {
		return nil, "", err
	}
	state, err := readWireGuardLocalKeyState(directory)
	if err != nil || state.ActiveFingerprint == "" {
		if err == nil {
			err = errors.New("wireguard active key unavailable")
		}
		return nil, "", err
	}
	if _, _, err = ensureWireGuardActiveKey(root, environmentID); err != nil {
		return nil, "", err
	}
	path := filepath.Join(directory, "client.pending.key")
	key, err := loadWireGuardPrivateKey(path)
	if errors.Is(err, os.ErrNotExist) {
		if state.PendingFingerprint != "" {
			return nil, "", errors.New("wireguard pending key unavailable")
		}
		key, err = createWireGuardPrivateKey(path)
		if errors.Is(err, os.ErrExist) {
			key, err = loadWireGuardPrivateKey(path)
		}
	}
	if err != nil {
		return nil, "", err
	}
	publicKey := wireGuardPublicKey(key)
	fingerprint := wireGuardFingerprint(publicKey)
	if state.PendingFingerprint != "" && state.PendingFingerprint != fingerprint {
		return nil, "", errors.New("wireguard pending key identity conflict")
	}
	if state.PendingFingerprint == "" {
		state.PendingFingerprint = fingerprint
		if err = writeWireGuardLocalKeyState(directory, state); err != nil {
			return nil, "", err
		}
	}
	return key, publicKey, nil
}

func (service *serviceRuntime) syncWireGuardPeers(catalog *clientVPNCatalog, token string) error {
	if catalog.ModuleState != "enabled" {
		return nil
	}
	for index := range catalog.Items {
		environment := &catalog.Items[index]
		if environment.Engine != "wireguard" {
			continue
		}
		if environment.WireGuardPeer != nil {
			if environment.WireGuardPeer.ServerPublicKey != environment.ServerPublicKey {
				return errors.New("wireguard server key mismatch")
			}
			if _, err := wireGuardClientKeyForPeer(service.dir, environment.ID, environment.WireGuardPeer.ClientPublicKey); err != nil {
				return errors.New("wireguard client key unavailable")
			}
			state, err := wireGuardStateForEnvironment(service.dir, environment.ID)
			if err != nil {
				return err
			}
			if state.PendingFingerprint != "" && state.ActiveFingerprint == wireGuardFingerprint(environment.WireGuardPeer.ClientPublicKey) {
				_, candidatePublicKey, keyErr := ensureWireGuardPendingKey(service.dir, environment.ID)
				if keyErr != nil {
					return errors.New("wireguard pending key unavailable")
				}
				var response wireGuardRegistrationResponse
				keyErr = postWithToken(service.base, "/v1/device/vpn/wireguard/peers", map[string]string{"environment_id": environment.ID, "public_key": candidatePublicKey, "action": "rotate"}, &response, token)
				if keyErr != nil {
					if strings.HasSuffix(keyErr.Error(), "returned 409") {
						environment.WireGuardState = "unavailable"
						continue
					}
					return keyErr
				}
				if !vpnruntime.ValidEnvironmentID(response.PeerID) || response.State != "active" && response.State != "pending" || response.PublicKeyFingerprint != wireGuardFingerprint(candidatePublicKey) || !validPrivateIPv4(response.TunnelIPv4) {
					return errors.New("invalid wireguard rotation response")
				}
				environment.WireGuardState = "pending_approval"
			} else {
				environment.WireGuardState = "active"
			}
			continue
		}

		state, err := wireGuardStateForEnvironment(service.dir, environment.ID)
		if err != nil {
			return err
		}
		var publicKey, action string
		if state.PendingFingerprint != "" {
			_, publicKey, err = ensureWireGuardPendingKey(service.dir, environment.ID)
			action = "rotate"
		} else {
			_, publicKey, err = ensureWireGuardActiveKey(service.dir, environment.ID)
			action = "register"
		}
		if err != nil {
			return errors.New("wireguard client key unavailable")
		}
		var response wireGuardRegistrationResponse
		err = postWithToken(service.base, "/v1/device/vpn/wireguard/peers", map[string]string{"environment_id": environment.ID, "public_key": publicKey, "action": action}, &response, token)
		if err != nil {
			// Environment transitions and a pending provider approval are transient;
			// they must not stop unrelated OpenVPN environments on this endpoint.
			if strings.HasSuffix(err.Error(), "returned 409") {
				environment.WireGuardState = "unavailable"
				continue
			}
			return err
		}
		if !vpnruntime.ValidEnvironmentID(response.PeerID) || !map[string]bool{"pending": true, "active": true}[response.State] || response.PublicKeyFingerprint != wireGuardFingerprint(publicKey) || !validPrivateIPv4(response.TunnelIPv4) {
			return errors.New("invalid wireguard registration response")
		}
		if response.State == "active" {
			environment.WireGuardState = "active"
		} else {
			environment.WireGuardState = "pending_approval"
		}
	}
	return nil
}

func (service *serviceRuntime) requestWireGuardRotation(environmentID string) error {
	current, session, err := authenticateSession(service.base, service.dir, service.key)
	if err != nil || current.Audience != "endpoint" {
		return errors.New("endpoint authentication required")
	}
	token, ok := session["token"].(string)
	if !ok {
		return errors.New("missing device session")
	}
	catalog, err := service.readVPNCatalog()
	if err != nil {
		return errors.New("vpn catalog unavailable")
	}
	var environment *clientVPNEnvironment
	for index := range catalog.Items {
		if catalog.Items[index].ID == environmentID {
			environment = &catalog.Items[index]
			break
		}
	}
	if environment == nil || environment.Engine != "wireguard" || environment.WireGuardPeer == nil {
		return errors.New("active wireguard peer required")
	}
	_, publicKey, err := ensureWireGuardPendingKey(service.dir, environmentID)
	if err != nil {
		return errors.New("wireguard rotation key unavailable")
	}
	if publicKey == environment.WireGuardPeer.ClientPublicKey {
		return errors.New("wireguard rotation key unchanged")
	}
	var response wireGuardRegistrationResponse
	if err = postWithToken(service.base, "/v1/device/vpn/wireguard/peers", map[string]string{"environment_id": environmentID, "public_key": publicKey, "action": "rotate"}, &response, token); err != nil {
		return err
	}
	if !vpnruntime.ValidEnvironmentID(response.PeerID) || response.State != "active" && response.State != "pending" || response.PublicKeyFingerprint != wireGuardFingerprint(publicKey) || !validPrivateIPv4(response.TunnelIPv4) {
		return errors.New("invalid wireguard rotation response")
	}
	environment.WireGuardState = "pending_approval"
	return service.writeVPNCatalog(catalog)
}

func renderManagedWireGuard(environment clientVPNEnvironment, host string, key *ecdh.PrivateKey) (string, error) {
	if !validManagedWireGuardEnvironment(environment) || !validManagedVPNHost(host) || key == nil || environment.WireGuardPeer == nil {
		return "", errors.New("invalid managed wireguard configuration")
	}
	peer := environment.WireGuardPeer
	if wireGuardPublicKey(key) != peer.ClientPublicKey || !validClientWireGuardPeer(environment) {
		return "", errors.New("wireguard key or peer mismatch")
	}
	endpoint := net.JoinHostPort(host, fmt.Sprint(environment.ListenerPort))
	lines := []string{
		"[Interface]",
		"PrivateKey = " + base64.StdEncoding.EncodeToString(key.Bytes()),
		"Address = " + peer.TunnelIPv4 + "/32",
		"MTU = 1420",
		"",
		"[Peer]",
		"PublicKey = " + peer.ServerPublicKey,
		"AllowedIPs = " + peer.ServerTunnelIPv4 + "/32",
		"Endpoint = " + endpoint,
		fmt.Sprintf("PersistentKeepalive = %d", peer.PersistentKeepaliveSeconds),
	}
	return strings.Join(lines, "\n") + "\n", nil
}

func validManagedWireGuardEnvironment(environment clientVPNEnvironment) bool {
	return vpnruntime.ValidEnvironmentID(environment.ID) && environment.Engine == "wireguard" && environment.Protocol == "udp" && environment.ListenerPort >= 1024 && environment.ListenerPort <= 65535 && environment.Revision > 0 && validWireGuardClientKey(environment.ServerPublicKey)
}

func validClientWireGuardPeer(environment clientVPNEnvironment) bool {
	peer := environment.WireGuardPeer
	if peer == nil || !validManagedWireGuardEnvironment(environment) || !vpnruntime.ValidEnvironmentID(peer.PeerID) || peer.ListenerPort != environment.ListenerPort || peer.ServerPublicKey != environment.ServerPublicKey || !validWireGuardClientKey(peer.ClientPublicKey) || !validWireGuardClientKey(peer.ServerPublicKey) || peer.PersistentKeepaliveSeconds != 0 && peer.PersistentKeepaliveSeconds != 25 || len(peer.AllowedIPs) != 1 {
		return false
	}
	clientIP, err := netip.ParseAddr(peer.TunnelIPv4)
	if err != nil || !validPrivateIPv4(clientIP.String()) {
		return false
	}
	serverIP, err := netip.ParseAddr(peer.ServerTunnelIPv4)
	if err != nil || !validPrivateIPv4(serverIP.String()) || clientIP == serverIP || peer.AllowedIPs[0] != serverIP.String()+"/32" {
		return false
	}
	return true
}

func validPrivateIPv4(value string) bool {
	address, err := netip.ParseAddr(value)
	if err != nil || !address.Is4() || address.String() != value {
		return false
	}
	return netip.MustParsePrefix("10.0.0.0/8").Contains(address) || netip.MustParsePrefix("172.16.0.0/12").Contains(address) || netip.MustParsePrefix("192.168.0.0/16").Contains(address)
}

func wireGuardStateForEnvironment(root, environmentID string) (wireGuardLocalKeyState, error) {
	directory, err := wireGuardClientDirectory(root, environmentID)
	if err != nil {
		return wireGuardLocalKeyState{}, err
	}
	return readWireGuardLocalKeyState(directory)
}

func wireGuardClientKeyForPeer(root, environmentID, expectedPublicKey string) (*ecdh.PrivateKey, error) {
	if !validWireGuardClientKey(expectedPublicKey) {
		return nil, errors.New("invalid wireguard peer key")
	}
	directory, err := wireGuardClientDirectory(root, environmentID)
	if err != nil {
		return nil, err
	}
	state, err := readWireGuardLocalKeyState(directory)
	if err != nil {
		return nil, err
	}
	for _, candidate := range []struct {
		path        string
		fingerprint string
		pending     bool
	}{
		{filepath.Join(directory, "client.key"), state.ActiveFingerprint, false},
		{filepath.Join(directory, "client.pending.key"), state.PendingFingerprint, true},
	} {
		key, loadErr := loadWireGuardPrivateKey(candidate.path)
		if errors.Is(loadErr, os.ErrNotExist) {
			continue
		}
		if loadErr != nil {
			return nil, loadErr
		}
		publicKey := wireGuardPublicKey(key)
		fingerprint := wireGuardFingerprint(publicKey)
		if candidate.fingerprint != "" && candidate.fingerprint != fingerprint {
			return nil, errors.New("wireguard private key identity conflict")
		}
		if publicKey != expectedPublicKey {
			continue
		}
		if candidate.pending {
			if err = promoteWireGuardPendingKey(directory, state, expectedPublicKey); err != nil {
				return nil, err
			}
		}
		return key, nil
	}
	return nil, errors.New("wireguard private key unavailable")
}

func promoteWireGuardPendingKey(directory string, state wireGuardLocalKeyState, publicKey string) error {
	path := filepath.Join(directory, "client.pending.key")
	activePath := filepath.Join(directory, "client.key")
	key, err := loadWireGuardPrivateKey(path)
	if errors.Is(err, os.ErrNotExist) {
		// Recover a crash after rename but before the non-secret state update.
		key, err = loadWireGuardPrivateKey(activePath)
		if err == nil && wireGuardPublicKey(key) == publicKey && state.PendingFingerprint == wireGuardFingerprint(publicKey) {
			state.ActiveFingerprint, state.PendingFingerprint = wireGuardFingerprint(publicKey), ""
			if err = writeWireGuardLocalKeyState(directory, state); err != nil {
				return err
			}
			return nil
		}
	}
	if err != nil || wireGuardPublicKey(key) != publicKey || state.PendingFingerprint != wireGuardFingerprint(publicKey) {
		return errors.New("wireguard pending key unavailable")
	}
	if err = os.Remove(activePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = os.Rename(path, activePath); err != nil {
		return err
	}
	state.ActiveFingerprint, state.PendingFingerprint = wireGuardFingerprint(publicKey), ""
	return writeWireGuardLocalKeyState(directory, state)
}

func readWireGuardLocalKeyState(directory string) (wireGuardLocalKeyState, error) {
	var state wireGuardLocalKeyState
	path := filepath.Join(directory, "keys.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if len(raw) > 256 || json.Unmarshal(raw, &state) != nil || !validWireGuardFingerprintOrEmpty(state.ActiveFingerprint) || !validWireGuardFingerprintOrEmpty(state.PendingFingerprint) {
		return wireGuardLocalKeyState{}, errors.New("wireguard key state invalid")
	}
	return state, nil
}

func writeWireGuardLocalKeyState(directory string, state wireGuardLocalKeyState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return writePrivateFile(filepath.Join(directory, "keys.json"), raw, 0600)
}

func loadWireGuardPrivateKey(path string) (*ecdh.PrivateKey, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 128 || runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		return nil, errors.New("wireguard private key unavailable")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != strings.TrimSpace(string(raw)) {
		return nil, errors.New("wireguard private key invalid")
	}
	key, err := ecdh.X25519().NewPrivateKey(decoded)
	if err != nil {
		return nil, errors.New("wireguard private key invalid")
	}
	return key, nil
}

func createWireGuardPrivateKey(path string) (*ecdh.PrivateKey, error) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.New("wireguard key generation failed")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	encoded := []byte(base64.StdEncoding.EncodeToString(key.Bytes()) + "\n")
	_, writeErr := file.Write(encoded)
	chmodErr := file.Chmod(0600)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err = errors.Join(writeErr, chmodErr, syncErr, closeErr); err != nil {
		_ = os.Remove(path)
		return nil, errors.New("wireguard key persistence failed")
	}
	return key, nil
}

func wireGuardPublicKey(key *ecdh.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(key.PublicKey().Bytes())
}

func wireGuardFingerprint(publicKey string) string {
	decoded, _ := base64.StdEncoding.DecodeString(publicKey)
	digest := sha256.Sum256(decoded)
	return hex.EncodeToString(digest[:])[:16]
}

func validWireGuardFingerprintOrEmpty(value string) bool {
	if value == "" {
		return true
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 8 && hex.EncodeToString(decoded) == value
}

func validWireGuardClientKey(value string) bool {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != value {
		return false
	}
	for _, b := range decoded {
		if b != 0 {
			return true
		}
	}
	return false
}

func wireGuardEnvironmentKeyPath(root, environmentID string, pending bool) (string, error) {
	directory, err := wireGuardClientDirectory(root, environmentID)
	if err != nil {
		return "", err
	}
	name := "client.key"
	if pending {
		name = "client.pending.key"
	}
	return filepath.Join(directory, name), nil
}

func describeWireGuardKeyError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("wireguard key operation failed: %w", err)
}
