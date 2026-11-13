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
	"regexp"
	"runtime"
	"sync"
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
		fail(fmt.Errorf("usage: nexo-agent enroll|enroll-gateway|claim|authenticate|rotate-node-credential|run-once|node-reconcile-once|node-service|service <base-url> <state-dir> [arguments]"))
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
	case "enroll-gateway":
		if len(os.Args) != 6 {
			fail(fmt.Errorf("enroll-gateway requires token and name"))
		}
		err = enroll(base, dir, key, os.Args[4], os.Args[5], "gateway", os.Stdout)
	case "enroll-node":
		if len(os.Args) != 6 {
			fail(fmt.Errorf("enroll-node requires token and name"))
		}
		err = enroll(base, dir, key, os.Args[4], os.Args[5], "node", os.Stdout)
	case "claim":
		err = claim(base, dir, os.Stdout)
	case "rotate-node-credential":
		if len(os.Args) != 5 {
			fail(fmt.Errorf("rotate-node-credential requires a rotation id"))
		}
		err = rotateNodeCredential(base, dir, key, os.Args[4], os.Stdout)
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

var nodeCredentialRotationID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func rotateNodeCredential(base, dir string, key *ecdsa.PrivateKey, rotationID string, output io.Writer) error {
	if !nodeCredentialRotationID.MatchString(rotationID) {
		return fmt.Errorf("invalid rotation id")
	}
	s, err := readState(dir)
	if err != nil {
		return err
	}
	if s.Audience != "node" || !nodeCredentialRotationID.MatchString(s.DeviceID) {
		return fmt.Errorf("node identity required")
	}
	signature, err := signPayload(key, "nexo-node-credential-rotation-v1\n"+s.DeviceID+"\n"+rotationID)
	if err != nil {
		return err
	}
	var certificate struct {
		CertificatePEM string `json:"certificate_pem"`
		Serial         string `json:"serial"`
		NotBefore      string `json:"not_before"`
		NotAfter       string `json:"not_after"`
	}
	path := "/v1/node-credential-rotations/" + rotationID + "/complete"
	if err = post(base, path, map[string]string{"node_id": s.DeviceID, "signature": signature}, &certificate); err != nil {
		return err
	}
	if certificate.Serial == "" || certificate.CertificatePEM == "" || certificate.NotBefore == "" || certificate.NotAfter == "" {
		return fmt.Errorf("invalid rotation certificate response")
	}
	oldSerial := s.Serial
	s.Serial = certificate.Serial
	s.CertificatePEM = certificate.CertificatePEM
	if err = writeState(dir, s); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"device_id": s.DeviceID, "old_serial": oldSerial, "serial": s.Serial, "status": "rotated"})
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

const (
	operationJournalStarted       = "started"
	operationJournalIndeterminate = "indeterminate"
	operationJournalFinal         = "final"
	revocationOperationType       = "vpn.client_certificate.revoke.v1"
)

// operationJournalEntry is written durably before an operation is executed.
// A started entry without a final result is never re-executed: it is reported
// as an indeterminate failure so a crash cannot replay client-kill.
type operationJournalEntry struct {
	ID        string           `json:"id"`
	Revision  int64            `json:"revision"`
	State     string           `json:"state"`
	Result    *operationResult `json:"result,omitempty"`
	UpdatedAt string           `json:"updated_at"`
}

// operationJournalMu serializes runOnce journal/execution in this process.
// Cross-process exclusion is provided separately by an OS file lock held for
// the full marker/execute/final sequence.
var operationJournalMu sync.Mutex

func operationJournalPath(dir, operationID string) string {
	sum := sha256.Sum256([]byte(operationID))
	return filepath.Join(dir, "operation-journal", fmt.Sprintf("%x.json", sum))
}

func legacyOperationResultsPath(dir string) string {
	return filepath.Join(dir, "operation-results.json")
}

// loadLegacyOperationResult migrates the previous cache format. A matching
// ID/revision is authoritative and must be replayed, never re-executed.
func loadLegacyOperationResult(dir, operationID string, revision int64) (operationResult, bool, error) {
	raw, err := os.ReadFile(legacyOperationResultsPath(dir))
	if errors.Is(err, os.ErrNotExist) {
		return operationResult{}, false, nil
	}
	if err != nil {
		return operationResult{}, false, err
	}
	var cache map[string]operationResult
	if err = json.Unmarshal(raw, &cache); err != nil {
		return operationResult{}, false, fmt.Errorf("invalid legacy operation cache: %w", err)
	}
	result, exists := cache[operationID]
	if !exists {
		return operationResult{}, false, nil
	}
	if result.Revision != revision {
		return operationResult{}, false, errors.New("legacy operation cache revision mismatch")
	}
	return result, true, nil
}

func legacyBool(value any, key string) bool {
	values, ok := value.(map[string]any)
	if !ok {
		return false
	}
	flag, ok := values[key].(bool)
	return ok && flag
}

func legacyInt64(value any) (int64, bool) {
	switch number := value.(type) {
	case float64:
		if number < 0 || number != float64(int64(number)) {
			return 0, false
		}
		return int64(number), true
	case int64:
		return number, true
	case int:
		return int64(number), true
	default:
		return 0, false
	}
}

// legacyRevocationResultIsTrustworthy only accepts a legacy result when the
// previous run explicitly recorded the complete management/SLA evidence. An
// old {serial, revoked:true} entry has none of these fields and must become
// operation_outcome_unknown instead of a false success.
func legacyRevocationResultIsTrustworthy(result operationResult) bool {
	if result.Status != "succeeded" {
		return false
	}
	values := result.Result
	for _, key := range []string{
		"revoked",
		"management_command_sent",
		"management_accepted",
		"disconnect_confirmed",
		"accept_within_budget",
		"disconnect_within_budget",
	} {
		if !legacyBool(values, key) {
			return false
		}
	}
	// Optional contemporary fields must not contradict the required evidence.
	if attempted, ok := values["management_command_attempted"].(bool); ok && !attempted {
		return false
	}
	if partial, ok := values["management_write_partial"].(bool); ok && partial {
		return false
	}
	if slaMet, ok := values["sla_met"].(bool); ok && !slaMet {
		return false
	}
	timings, ok := values["timings"].(map[string]any)
	if !ok {
		return false
	}
	acceptNS, ok := legacyInt64(timings["accept_elapsed_ns"])
	if !ok || acceptNS < 0 || acceptNS > int64(2*time.Second) {
		return false
	}
	disconnectNS, ok := legacyInt64(timings["disconnect_elapsed_ns"])
	if !ok || disconnectNS < 0 || disconnectNS < acceptNS || disconnectNS > int64(10*time.Second) {
		return false
	}
	return true
}

func legacyRevocationUnknownResult(revision int64, legacy operationResult) operationResult {
	result := indeterminateOperationResult(revision)
	if serial, ok := legacy.Result["serial"].(string); ok && serial != "" {
		result.Result["serial"] = serial
	}
	if revoked, ok := legacy.Result["revoked"].(bool); ok && revoked {
		result.Result["revoked"] = true
	}
	return result
}

func loadOperationJournalEntry(path string) (operationJournalEntry, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return operationJournalEntry{}, false, nil
	}
	if err != nil {
		return operationJournalEntry{}, false, err
	}
	var entry operationJournalEntry
	if err = json.Unmarshal(raw, &entry); err != nil {
		return operationJournalEntry{}, false, fmt.Errorf("invalid operation journal: %w", err)
	}
	return entry, true, nil
}

func writeOperationJournalEntryAtomic(path string, entry operationJournalEntry) error {
	directory := filepath.Dir(path)
	directoryExisted := true
	if _, statErr := os.Stat(directory); errors.Is(statErr, os.ErrNotExist) {
		directoryExisted = false
	} else if statErr != nil {
		return statErr
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if !directoryExisted {
		// Persist the new journal directory entry before any side effect.
		if err := syncOperationJournalDirectory(filepath.Dir(directory)); err != nil {
			return err
		}
	}
	temp, err := os.CreateTemp(directory, ".operation-journal-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err = json.NewEncoder(temp).Encode(entry); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tempPath, path); err != nil {
		return err
	}
	// The rename is atomic; directory fsync is required before the caller may
	// execute the side effect.
	if err = syncOperationJournalDirectory(directory); err != nil {
		return err
	}
	return nil
}

func indeterminateOperationResult(revision int64) operationResult {
	return operationResult{
		Status:     "failed",
		ObservedAt: time.Now().UTC().Format(time.RFC3339),
		Revision:   revision,
		Result: map[string]any{
			"code": "operation_outcome_unknown",
			"note": "write-ahead operation marker found without final result; operation was not re-executed",
		},
	}
}

// executeOperationWithJournal provides the crash/redelivery guarantee:
//   - a durable started marker is persisted before execute;
//   - if any marker exists without a final result, execute is not called and an
//     indeterminate failed result is stored;
//   - final results, including indeterminate ones, are persisted atomically.
//
// persist is injectable so tests can cover write failures deterministically.
func executeOperationWithJournal(dir, operationID string, revision int64, operationType string, execute func() operationResult, persist func(string, operationJournalEntry) error) (operationResult, bool, error) {
	if dir == "" || operationID == "" || execute == nil || persist == nil {
		return operationResult{}, false, errors.New("invalid operation journal request")
	}
	operationJournalMu.Lock()
	defer operationJournalMu.Unlock()
	releaseLock, lockErr := acquireOperationJournalLock(dir)
	if lockErr != nil {
		return operationResult{}, false, lockErr
	}
	defer releaseLock()

	path := operationJournalPath(dir, operationID)
	entry, exists, err := loadOperationJournalEntry(path)
	if err != nil {
		return operationResult{}, false, err
	}
	if exists {
		if entry.ID != operationID || entry.Revision != revision {
			return operationResult{}, false, errors.New("operation journal identity mismatch")
		}
		switch entry.State {
		case operationJournalFinal:
			if entry.Result == nil {
				return operationResult{}, false, errors.New("operation journal final result missing")
			}
			finalResult := *entry.Result
			if operationType == revocationOperationType && finalResult.Status == "succeeded" && !legacyRevocationResultIsTrustworthy(finalResult) {
				// Repair a journal final produced by an earlier migration of
				// the old {serial,revoked:true} cache: never replay it as PASS.
				finalResult = legacyRevocationUnknownResult(revision, finalResult)
				entry.Result = &finalResult
				entry.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
				if err = persist(path, entry); err != nil {
					return operationResult{}, true, err
				}
			}
			return finalResult, true, nil
		case operationJournalStarted, operationJournalIndeterminate:
			result := indeterminateOperationResult(revision)
			entry.State = operationJournalFinal
			entry.Result = &result
			entry.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			if err = persist(path, entry); err != nil {
				return operationResult{}, true, err
			}
			return result, true, nil
		default:
			return operationResult{}, false, errors.New("operation journal state is unknown")
		}
	}
	legacyResult, legacyExists, legacyErr := loadLegacyOperationResult(dir, operationID, revision)
	if legacyErr != nil {
		return operationResult{}, false, legacyErr
	}
	if legacyExists {
		migrated := legacyResult
		if operationType == revocationOperationType && !legacyRevocationResultIsTrustworthy(legacyResult) {
			migrated = legacyRevocationUnknownResult(revision, legacyResult)
		}
		final := operationJournalEntry{
			ID:        operationID,
			Revision:  revision,
			State:     operationJournalFinal,
			Result:    &migrated,
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		}
		if err = persist(path, final); err != nil {
			return operationResult{}, false, err
		}
		return migrated, true, nil
	}
	started := operationJournalEntry{
		ID:        operationID,
		Revision:  revision,
		State:     operationJournalStarted,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err = persist(path, started); err != nil {
		return operationResult{}, false, err
	}
	result := execute()
	final := operationJournalEntry{
		ID:        operationID,
		Revision:  revision,
		State:     operationJournalFinal,
		Result:    &result,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err = persist(path, final); err != nil {
		// The started marker remains: redelivery reports an indeterminate
		// failure and never executes this operation again.
		return result, false, err
	}
	return result, false, nil
}

// revocationOperationResult keeps the revocation effects separate: a CRL that
// has been published remains revoked even when the management disconnect
// failed. disconnect_requested/management_accepted only report a complete
// SUCCESS: terminal from management; disconnect_confirmed alone reports the
// final status 3 absence plus control peer. The result is cached even when the
// disconnect is unconfirmed so redelivery cannot repeat client-kill; a new
// explicit operation is required for another attempt.
func revocationOperationResult(revocation vpnruntime.RevocationResult, revokeErr error, observedAt string, revision int64) operationResult {
	if revokeErr == nil && (!revocation.ManagementCommandSent || !revocation.DisconnectConfirmed) {
		// A successful result must always carry both the written/accepted
		// command and the final status confirmation.
		revokeErr = vpnruntime.ErrRevocationPublished
	}
	if revokeErr == nil && (!revocation.AcceptWithinBudget || !revocation.DisconnectWithinBudget) {
		// Never report a temporal SLA PASS for a late measurement.
		revokeErr = vpnruntime.ErrRevocationSLAExceeded
	}
	result := operationResult{
		Status:     "succeeded",
		ObservedAt: observedAt,
		Revision:   revision,
		Result: map[string]any{
			"serial":                       revocation.Serial,
			"revoked":                      revocation.Revoked,
			"disconnect_requested":         revocation.DisconnectRequested,
			"management_command_sent":      revocation.ManagementCommandSent,
			"management_command_attempted": revocation.ManagementCommandAttempted || revocation.ManagementCommandSent,
			"management_write_partial":     revocation.ManagementWritePartial,
			"management_accepted":          revocation.ManagementAccepted,
			"disconnect_confirmed":         revocation.DisconnectConfirmed,
			"accept_within_budget":         revocation.AcceptWithinBudget,
			"disconnect_within_budget":     revocation.DisconnectWithinBudget,
			"sla_met":                      revocation.AcceptWithinBudget && revocation.DisconnectWithinBudget,
			"timings":                      revocation.Timings,
		},
	}
	if revokeErr != nil {
		code := "serial_mismatch"
		switch {
		case errors.Is(revokeErr, vpnruntime.ErrRevocationPublishFailed):
			code = "revocation_publish_failed"
		case errors.Is(revokeErr, vpnruntime.ErrRevocationSLAExceeded):
			code = "sla_exceeded"
		case errors.Is(revokeErr, vpnruntime.ErrRevocationRecordUpdate):
			code = "revocation_record_update_failed"
		case errors.Is(revokeErr, vpnruntime.ErrDisconnectNotAttempted):
			code = "disconnect_not_attempted"
		case errors.Is(revokeErr, vpnruntime.ErrDisconnectRejected):
			code = "disconnect_rejected"
		case errors.Is(revokeErr, vpnruntime.ErrRevocationPublished):
			code = "disconnect_unconfirmed"
		}
		result.Status = "failed"
		result.Result["code"] = code
	}
	return result
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
	result, replayed, err := executeOperationWithJournal(dir, next.Operation.ID, next.Operation.Revision, next.Operation.Type, func() operationResult {
		return executeOperation(s.Audience, expected, next.Operation.Type, next.Operation.Arguments, next.Operation.Revision)
	}, writeOperationJournalEntryAtomic)
	if err != nil {
		return err
	}
	if err = postWithToken(base, "/v1/"+prefix+"/operations/"+next.Operation.ID+"/result", result, &ignored, token); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"device_id": s.DeviceID, "operation_id": next.Operation.ID, "status": result.Status, "cached": replayed})
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
	case revocationOperationType:
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
		revocation, revokeErr := vpnruntime.RevokeClientCertificate(requestID, environmentID, tenantID, deviceID, serial)
		return revocationOperationResult(revocation, revokeErr, result.ObservedAt, result.Revision)
	}
	result.Status, result.Result = "failed", map[string]any{"code": "execution_error"}
	return result
}
