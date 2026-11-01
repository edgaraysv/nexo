package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"nexo.local/agent/internal/keystore"
	"nexo.local/agent/internal/labfixture"
	"nexo.local/agent/internal/updater"
	"nexo.local/agent/internal/vpnruntime"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

type state struct {
	DeviceID       string `json:"device_id"`
	Audience       string `json:"audience"`
	ClaimToken     string `json:"claim_token,omitempty"`
	Serial         string `json:"serial,omitempty"`
	CertificatePEM string `json:"certificate_pem,omitempty"`
}
type sig struct{ R, S *big.Int }

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
func main() {
	if len(os.Args) == 3 && os.Args[1] == "initialize-update-state" {
		if _, err := updater.LoadOrInitializeSecurityState(filepath.Join(os.Args[2], "update-security-state.bin"), agentVersion); err != nil {
			fail(fmt.Errorf("update security state initialization failed"))
		}
		return
	}
	if len(os.Args) == 4 && os.Args[1] == "lab-fixture" {
		if err := labfixture.Run(os.Args[2], os.Args[3]); err != nil {
			fail(err)
		}
		return
	}
	if len(os.Args) < 4 {
		fail(fmt.Errorf("usage: nexo-agent enroll|claim|authenticate|run-once|node-reconcile-once|node-service|service <base-url> <state-dir> [arguments]"))
	}
	cmd, base, dir := os.Args[1], os.Args[2], os.Args[3]
	if err := validateBaseURL(base); err != nil {
		fail(err)
	}
	key, err := keystore.LoadOrCreate(filepath.Join(dir, "device-key"))
	if err != nil {
		fail(err)
	}
	switch cmd {
	case "enroll":
		if len(os.Args) != 6 {
			fail(fmt.Errorf("enroll requires token and name"))
		}
		err = enroll(base, dir, key, os.Args[4], os.Args[5], "endpoint", os.Stdout)
	case "enroll-node":
		if len(os.Args) != 6 {
			fail(fmt.Errorf("enroll-node requires token and name"))
		}
		err = enroll(base, dir, key, os.Args[4], os.Args[5], "node", os.Stdout)
	case "claim":
		err = claim(base, dir, os.Stdout)
	case "authenticate":
		err = authenticate(base, dir, key)
	case "renew":
		err = renew(base, dir, key)
	case "run-once":
		err = runOnce(base, dir, key, os.Stdout)
	case "node-reconcile-once":
		if len(os.Args) != 4 {
			fail(fmt.Errorf("node-reconcile-once accepts no arguments"))
		}
		err = reconcileNodeVPN(base, dir, key, vpnruntime.New(vpnruntime.NewNativeHost()), os.Stdout)
	case "node-service":
		if len(os.Args) != 4 {
			fail(fmt.Errorf("node-service accepts no arguments"))
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		err = runNodeService(ctx, base, dir, key, vpnruntime.New(vpnruntime.NewNativeHost()))
	case "service":
		if len(os.Args) < 5 || len(os.Args) > 6 {
			fail(fmt.Errorf("service requires IPC endpoint and optional allowed SID"))
		}
		allowedSID := ""
		if len(os.Args) == 6 {
			allowedSID = os.Args[5]
		}
		err = runService(base, dir, os.Args[4], allowedSID, key)
	case "windows-service":
		if len(os.Args) != 5 {
			fail(fmt.Errorf("windows-service requires allowed SID"))
		}
		err = runWindowsService(base, dir, os.Args[4], key)
	default:
		err = fmt.Errorf("unknown command")
	}
	if err != nil {
		fail(err)
	}
}

type nodeVPNReconciler interface {
	Reconcile([]vpnruntime.DesiredEnvironment, vpnruntime.Progress) []vpnruntime.Result
}

func reconcileNodeVPN(base, dir string, key *ecdsa.PrivateKey, reconciler nodeVPNReconciler, output io.Writer) error {
	s, session, err := authenticateSession(base, dir, key)
	if err != nil {
		return err
	}
	if s.Audience != "node" {
		return fmt.Errorf("node identity required")
	}
	token, ok := session["token"].(string)
	if !ok {
		return fmt.Errorf("missing node session")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	var ignored map[string]any
	if err = postWithToken(base, "/v1/node/heartbeat", map[string]string{"observed_at": now, "agent_version": "0.2.0"}, &ignored, token); err != nil {
		return err
	}
	var desired struct {
		Items []vpnruntime.DesiredEnvironment `json:"items"`
	}
	if err = postWithToken(base, "/v1/node/vpn-environments/reconcile", map[string]any{}, &desired, token); err != nil {
		return err
	}
	seen := map[string]struct{}{}
	for _, environment := range desired.Items {
		if !vpnruntime.ValidEnvironmentID(environment.ID) {
			return fmt.Errorf("invalid desired environment")
		}
		if _, duplicate := seen[environment.ID]; duplicate {
			return fmt.Errorf("duplicate desired environment")
		}
		seen[environment.ID] = struct{}{}
	}
	report := func(result vpnruntime.Result) error {
		return postWithToken(base, "/v1/node/vpn-environments/"+result.ID+"/report", result, &ignored, token)
	}
	results := reconciler.Reconcile(desired.Items, report)
	var reportFailures []error
	for _, result := range results {
		if reportErr := report(result); reportErr != nil {
			reportFailures = append(reportFailures, reportErr)
		}
	}
	if err = errors.Join(reportFailures...); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"node_id": s.DeviceID, "environments": len(results), "status": "reconciled"})
}

func runNodeService(ctx context.Context, base, dir string, key *ecdsa.PrivateKey, reconciler nodeVPNReconciler) error {
	current, err := readState(dir)
	if err != nil || current.Audience != "node" || current.Serial == "" {
		return fmt.Errorf("approved node identity required")
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if reconcileNodeVPN(base, dir, key, reconciler, io.Discard) != nil {
			fmt.Fprintln(os.Stderr, "nexo_node_vpn_reconcile_failed")
		}
		if runOnce(base, dir, key, io.Discard) != nil {
			fmt.Fprintln(os.Stderr, "nexo_node_operation_cycle_failed")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func validateBaseURL(base string) error {
	parsed, err := url.Parse(base)
	if err != nil {
		return err
	}
	if parsed.Scheme == "https" {
		return nil
	}
	host := parsed.Hostname()
	if parsed.Scheme == "http" && (host == "127.0.0.1" || host == "::1" || host == "localhost") {
		return nil
	}
	return fmt.Errorf("https is required outside loopback development")
}
func post(base, path string, input any, output any) error {
	return postWithToken(base, path, input, output, "")
}
func postWithToken(base, path string, input any, output any, token string) error {
	body, _ := json.Marshal(input)
	client := http.Client{Timeout: 10 * time.Second}
	request, err := http.NewRequest(http.MethodPost, base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%s returned %d", path, response.StatusCode)
	}
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(output)
}

// getWithToken performs an authenticated read and returns the HTTP status even
// when the control plane answers with a non-200 code.
func getWithToken(base, path string, output any, token string) (int, error) {
	client := http.Client{Timeout: 10 * time.Second}
	request, err := http.NewRequest(http.MethodGet, base+path, nil)
	if err != nil {
		return 0, err
	}
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return response.StatusCode, nil
	}
	if err = json.NewDecoder(response.Body).Decode(output); err != nil {
		return response.StatusCode, err
	}
	return response.StatusCode, nil
}
func signPayload(key *ecdsa.PrivateKey, payload string) (string, error) {
	sum := sha256.Sum256([]byte(payload))
	r, s, err := ecdsa.Sign(rand.Reader, key, sum[:])
	if err != nil {
		return "", err
	}
	der, err := asn1.Marshal(sig{r, s})
	return base64.StdEncoding.EncodeToString(der), err
}
func readState(dir string) (state, error) {
	var s state
	raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(raw, &s)
	return s, err
}
func writeState(dir string, s state) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	raw, _ := json.Marshal(s)
	return os.WriteFile(filepath.Join(dir, "state.json"), raw, 0600)
}
func enroll(base, dir string, key *ecdsa.PrivateKey, token, name, audience string, output io.Writer) error {
	public, err := keystore.PublicPEM(key)
	if err != nil {
		return err
	}
	raw := map[string]any{"token": token, "name": name, "audience": audience, "public_key_pem": public}
	body, _ := json.Marshal(raw)
	prefix, idKey, canonical := "device", "device_id", "nexo-enrollment-v1"
	if audience == "node" {
		prefix, idKey, canonical = "node", "node_id", "nexo-node-enrollment-v1"
	}
	response, err := http.Post(base+"/v1/"+prefix+"-enrollment/start", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var value map[string]any
	if err = json.NewDecoder(response.Body).Decode(&value); err != nil {
		return err
	}
	if response.StatusCode != 201 {
		return fmt.Errorf("start returned %d", response.StatusCode)
	}
	id := value[idKey].(string)
	challenge := value["challenge"].(string)
	claimToken := value["claim_token"].(string)
	signature, err := signPayload(key, canonical+"\n"+id+"\n"+challenge)
	if err != nil {
		return err
	}
	var pending map[string]any
	if err = post(base, "/v1/"+prefix+"-enrollment/prove", map[string]string{idKey: id, "challenge": challenge, "signature": signature}, &pending); err != nil {
		return err
	}
	if err = writeState(dir, state{DeviceID: id, Audience: audience, ClaimToken: claimToken}); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"device_id": id, "status": "pending_approval"})
}
func claim(base, dir string, output io.Writer) error {
	s, err := readState(dir)
	if err != nil {
		return err
	}
	var cert struct {
		CertificatePEM string `json:"certificate_pem"`
		Serial         string `json:"serial"`
	}
	prefix, idKey := "device", "device_id"
	if s.Audience == "node" {
		prefix, idKey = "node", "node_id"
	}
	if err = post(base, "/v1/"+prefix+"-enrollment/claim", map[string]string{idKey: s.DeviceID, "claim_token": s.ClaimToken}, &cert); err != nil {
		return err
	}
	s.ClaimToken = ""
	s.CertificatePEM = cert.CertificatePEM
	s.Serial = cert.Serial
	if err = writeState(dir, s); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"device_id": s.DeviceID, "serial": s.Serial, "status": "approved"})
}
func authenticate(base, dir string, key *ecdsa.PrivateKey) error {
	s, session, err := authenticateSession(base, dir, key)
	if err != nil {
		return err
	}
	session["device_id"] = s.DeviceID
	return json.NewEncoder(os.Stdout).Encode(session)
}
func authenticateSession(base, dir string, key *ecdsa.PrivateKey) (state, map[string]any, error) {
	s, err := readState(dir)
	if err != nil {
		return s, nil, err
	}
	var challenge struct {
		Challenge string `json:"challenge"`
	}
	prefix, idKey, canonical := "device", "device_id", "nexo-auth-v1"
	if s.Audience == "node" {
		prefix, idKey, canonical = "node", "node_id", "nexo-node-auth-v1"
	}
	if err = post(base, "/v1/"+prefix+"-auth/challenge", map[string]string{idKey: s.DeviceID, "serial": s.Serial, "certificate_pem": s.CertificatePEM}, &challenge); err != nil {
		return s, nil, err
	}
	signature, err := signPayload(key, canonical+"\n"+s.DeviceID+"\n"+s.Serial+"\n"+challenge.Challenge)
	if err != nil {
		return s, nil, err
	}
	var session map[string]any
	if err = post(base, "/v1/"+prefix+"-auth/verify", map[string]string{idKey: s.DeviceID, "serial": s.Serial, "challenge": challenge.Challenge, "signature": signature}, &session); err != nil {
		return s, nil, err
	}
	return s, session, nil
}
func renew(base, dir string, key *ecdsa.PrivateKey) error {
	s, session, err := authenticateSession(base, dir, key)
	if err != nil {
		return err
	}
	token, ok := session["token"].(string)
	if !ok {
		return fmt.Errorf("missing device session")
	}
	var cert struct {
		CertificatePEM string `json:"certificate_pem"`
		Serial         string `json:"serial"`
	}
	if err = postWithToken(base, "/v1/device/renew", map[string]string{}, &cert, token); err != nil {
		return err
	}
	old := s.Serial
	s.Serial = cert.Serial
	s.CertificatePEM = cert.CertificatePEM
	if err = writeState(dir, s); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"device_id": s.DeviceID, "old_serial": old, "serial": s.Serial, "status": "renewed"})
}

type operationResult struct {
	Status     string         `json:"status"`
	Result     map[string]any `json:"result"`
	ObservedAt string         `json:"observed_at"`
	Revision   int64          `json:"revision"`
}

func runOnce(base, dir string, key *ecdsa.PrivateKey, output io.Writer) error {
	s, session, err := authenticateSession(base, dir, key)
	if err != nil {
		return err
	}
	token, ok := session["token"].(string)
	if !ok {
		return fmt.Errorf("missing device session")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	var ignored map[string]any
	prefix, expected := "device", "endpoint.runtime_info.v1"
	if s.Audience == "node" {
		prefix, expected = "node", "node.runtime_info.v1"
	}
	if err = postWithToken(base, "/v1/"+prefix+"/heartbeat", map[string]string{"observed_at": now, "agent_version": "0.1.0"}, &ignored, token); err != nil {
		return err
	}
	var next struct {
		Operation *struct {
			ID        string         `json:"id"`
			Type      string         `json:"type"`
			Arguments map[string]any `json:"arguments"`
			Revision  int64          `json:"revision"`
		} `json:"operation"`
	}
	if err = postWithToken(base, "/v1/"+prefix+"/operations/next", map[string]any{}, &next, token); err != nil {
		return err
	}
	if next.Operation == nil {
		return json.NewEncoder(output).Encode(map[string]any{"device_id": s.DeviceID, "status": "idle"})
	}
	cachePath := filepath.Join(dir, "operation-results.json")
	cache := map[string]operationResult{}
	if raw, readErr := os.ReadFile(cachePath); readErr == nil {
		_ = json.Unmarshal(raw, &cache)
	}
	result, exists := cache[next.Operation.ID]
	if exists && result.Revision != next.Operation.Revision {
		return fmt.Errorf("cached operation revision mismatch")
	}
	if !exists {
		result = executeOperation(s.Audience, expected, next.Operation.Type, next.Operation.Arguments, next.Operation.Revision)
		cache[next.Operation.ID] = result
		raw, _ := json.Marshal(cache)
		if err = os.WriteFile(cachePath, raw, 0600); err != nil {
			return err
		}
	}
	if err = postWithToken(base, "/v1/"+prefix+"/operations/"+next.Operation.ID+"/result", result, &ignored, token); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"device_id": s.DeviceID, "operation_id": next.Operation.ID, "status": result.Status, "cached": exists})
}

func executeOperation(audience, expected, operationType string, arguments map[string]any, revision int64) operationResult {
	result := operationResult{Status: "succeeded", ObservedAt: time.Now().UTC().Format(time.RFC3339), Revision: revision}
	if operationType == expected && len(arguments) == 0 {
		result.Result = map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "go_version": runtime.Version()}
		return result
	}
	if audience != "node" {
		result.Status, result.Result = "failed", map[string]any{"code": "execution_error"}
		return result
	}
	stringArgument := func(name string) (string, bool) {
		value, ok := arguments[name].(string)
		return value, ok && value != ""
	}
	switch operationType {
	case "vpn.client_certificate.issue.v1":
		if len(arguments) != 5 {
			break
		}
		requestID, a := stringArgument("request_id")
		environmentID, b := stringArgument("environment_id")
		tenantID, c := stringArgument("tenant_id")
		deviceID, d := stringArgument("device_id")
		csrPEM, e := stringArgument("csr_pem")
		if !a || !b || !c || !d || !e {
			break
		}
		certificate, err := vpnruntime.IssueClientCertificate(requestID, environmentID, tenantID, deviceID, csrPEM)
		if err != nil {
			result.Status, result.Result = "failed", map[string]any{"code": "invalid_csr"}
			return result
		}
		result.Result = map[string]any{"serial": certificate.Serial, "certificate_pem": certificate.CertificatePEM, "ca_certificate_pem": certificate.CACertificatePEM, "tls_crypt_key_envelope": certificate.TLSCryptKeyEnvelope, "not_before": certificate.NotBefore, "not_after": certificate.NotAfter}
		return result
	case "vpn.client_certificate.revoke.v1":
		if len(arguments) != 5 {
			break
		}
		requestID, a := stringArgument("request_id")
		environmentID, b := stringArgument("environment_id")
		tenantID, c := stringArgument("tenant_id")
		deviceID, d := stringArgument("device_id")
		serial, e := stringArgument("serial")
		if !a || !b || !c || !d || !e {
			break
		}
		if err := vpnruntime.RevokeClientCertificate(requestID, environmentID, tenantID, deviceID, serial); err != nil {
			result.Status, result.Result = "failed", map[string]any{"code": "serial_mismatch"}
			return result
		}
		result.Result = map[string]any{"serial": serial, "revoked": true}
		return result
	}
	result.Status, result.Result = "failed", map[string]any{"code": "execution_error"}
	return result
}
