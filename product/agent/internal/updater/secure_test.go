package updater

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const releaseKeyID = "test-release-2026"

func secureFixture(t *testing.T, body []byte, now time.Time, mutate func(*SecureManifest)) ([]byte, ed25519.PublicKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(body)
	manifest := SecureManifest{
		Schema: SecureSchema, Version: "0.2.0", OperatingSystem: "windows", Architecture: "amd64",
		Size: int64(len(body)), SHA256: hex.EncodeToString(hash[:]),
		MinimumCurrentVersion: "0.1.0", MinimumAllowedVersion: "0.2.0",
		MetadataVersion: 1, SecurityEpoch: 1, KeyID: releaseKeyID,
		IssuedAt: now.UTC().Format(time.RFC3339), ExpiresAt: now.Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339),
	}
	if mutate != nil {
		mutate(&manifest)
	}
	signed, err := SigningBytesV2(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, signed))
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return encoded, public
}

func TestKMSRawEd25519SignatureUsesGoEd25519Verifier(t *testing.T) {
	now := time.Date(2026, time.October, 31, 12, 0, 0, 0, time.UTC)
	raw, public := secureFixture(t, []byte("kms-compatible-message"), now, nil)
	manifest, err := DecodeSecureManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := SigningBytesV2(manifest)
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"schema":"nexo.agent-update.v2","version":"0.2.0","operating_system":"windows","architecture":"amd64","size":22,"sha256":"` + manifest.SHA256 + `","minimum_current_version":"0.1.0","minimum_allowed_version":"0.2.0","metadata_version":1,"security_epoch":1,"blocked_rollback_versions":[],"key_id":"test-release-2026","issued_at":"2026-10-31T12:00:00Z","expires_at":"2026-11-30T12:00:00Z"}`
	if string(signed) != expected {
		t.Fatalf("Go KMS signing payload differs from signer contract:\n%s", signed)
	}
	signature, err := base64.StdEncoding.DecodeString(manifest.Signature)
	if err != nil {
		t.Fatal(err)
	}
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(public, signed, signature) {
		t.Fatal("raw 64-byte Ed25519 signature was not accepted by Go")
	}
}

func TestLiveLabKMSManifestIsAcceptedByGoVerifier(t *testing.T) {
	const fixtureDir = "testdata/live-kms-ed25519"
	rawManifest, err := os.ReadFile(filepath.Join(fixtureDir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	rawKeyring, err := os.ReadFile(filepath.Join(fixtureDir, "keyring.json"))
	if err != nil {
		t.Fatal(err)
	}
	keyring, err := ParseTrustKeyringJSON(rawKeyring)
	if err != nil {
		t.Fatal(err)
	}
	state, err := InitializeSecurityState("0.1.0")
	if err != nil {
		t.Fatal(err)
	}

	// Freeze time at the live manifest's issuance instant. Expiry behavior is
	// covered separately; this fixture preserves the real KMS signature vector.
	issuedAt := time.Date(2026, time.November, 1, 22, 4, 53, 0, time.UTC)
	manifest, err := VerifySecureManifest(rawManifest, "0.1.0", "windows", "amd64", state, keyring, issuedAt)
	if err != nil {
		t.Fatalf("Go rejected the manifest signed by live AWS KMS: %v", err)
	}
	if manifest.KeyID != "nexo-lab-f12-2026-11" || manifest.Version != "0.2.0" {
		t.Fatalf("unexpected verified KMS manifest: key=%q version=%q", manifest.KeyID, manifest.Version)
	}
}

func TestReleaseSignerEd25519ReferenceVectorIsAcceptedByGo(t *testing.T) {
	public, err := base64.StdEncoding.DecodeString("A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=")
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.StdEncoding.DecodeString("+8pUx+tHcpBJC36+AUq9MYJ2xqEI5mLuDTwJ8sVGTaQk2JjzYtqXL3QC9P+bWSS3bzCKjMQciQ7m4ZSCePuSCw==")
	if err != nil {
		t.Fatal(err)
	}
	message := []byte(`{"schema":"nexo.agent-update.v2","version":"0.2.0","operating_system":"windows","architecture":"amd64","size":22,"sha256":"0000000000000000000000000000000000000000000000000000000000000000","minimum_current_version":"0.1.0","minimum_allowed_version":"0.2.0","metadata_version":1,"security_epoch":1,"blocked_rollback_versions":[],"key_id":"cross-runtime","issued_at":"2026-10-31T12:00:00Z","expires_at":"2026-11-30T12:00:00Z"}`)
	if !ed25519.Verify(ed25519.PublicKey(public), message, signature) {
		t.Fatal("Node/KMS-compatible 64-byte Ed25519 signature was rejected by Go")
	}
}

func TestSecureManifestStagesAndRevalidatesSignedPackage(t *testing.T) {
	now := time.Date(2026, time.October, 31, 12, 0, 0, 0, time.UTC)
	body := []byte("signed-windows-agent")
	raw, public := secureFixture(t, body, now, func(value *SecureManifest) {
		value.MinimumAllowedVersion = "0.1.0"
		value.BlockedRollbackVersions = []string{"0.0.9"}
	})
	state, err := InitializeSecurityState("0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	keyring := map[string]ed25519.PublicKey{releaseKeyID: public}
	dir := t.TempDir()
	pending, manifest, err := StageSecureRelease(raw, bytes.NewReader(body), dir, "0.1.0", "windows", "amd64", state, keyring, now)
	if err != nil {
		t.Fatal(err)
	}
	if pending.Version != manifest.Version || !pending.RollbackAllowed || pending.Package != "nexo-agent.pending.exe" {
		t.Fatalf("unexpected pending release: %#v", pending)
	}
	if _, _, err = ValidateStagedSecureRelease(dir, state, keyring, now); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, pending.Package), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = ValidateStagedSecureRelease(dir, state, keyring, now); err == nil {
		t.Fatal("tampered staged package was accepted")
	}
}

func TestRollbackPermissionRequiresSignedFloorAndIgnoresMutablePendingFlag(t *testing.T) {
	now := time.Date(2026, time.October, 31, 12, 0, 0, 0, time.UTC)
	body := []byte("signed-windows-agent")
	raw, public := secureFixture(t, body, now, func(value *SecureManifest) {
		value.MinimumAllowedVersion = "0.2.0"
	})
	state, err := InitializeSecurityState("0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	pending, _, err := StageSecureRelease(raw, bytes.NewReader(body), directory, "0.1.0", "windows", "amd64", state, map[string]ed25519.PublicKey{releaseKeyID: public}, now)
	if err != nil {
		t.Fatal(err)
	}
	if pending.RollbackAllowed {
		t.Fatal("rollback below the signed minimum allowed version was permitted")
	}
	pending.RollbackAllowed = true // This file is mutable; it must not grant rollback authority.
	encoded, _ := json.Marshal(pending)
	if err = os.WriteFile(filepath.Join(directory, "update-state.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	_, validated, err := ValidateStagedSecureRelease(directory, state, map[string]ed25519.PublicKey{releaseKeyID: public}, now)
	if err != nil {
		t.Fatal(err)
	}
	if validated.RollbackAllowed {
		t.Fatal("mutable pending state overrode the signed rollback policy")
	}
}

func TestCandidateRuntimeRequiresSignedStagedManifestAndExactExecutableBytes(t *testing.T) {
	now := time.Date(2026, time.October, 31, 12, 0, 0, 0, time.UTC)
	body := []byte("pending signed agent executable")
	raw, public := secureFixture(t, body, now, nil)
	state, err := InitializeSecurityState("0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	if _, _, err = StageSecureRelease(raw, bytes.NewReader(body), staging, "0.1.0", "windows", "amd64", state, map[string]ed25519.PublicKey{releaseKeyID: public}, now); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(t.TempDir(), "nexo-agent.exe")
	if err = os.WriteFile(executable, body, 0600); err != nil {
		t.Fatal(err)
	}
	keyring := map[string]ed25519.PublicKey{releaseKeyID: public}
	if err = ValidateStagedExecutable(staging, executable, "0.2.0", state, keyring, now); err != nil {
		t.Fatalf("valid signed candidate rejected: %v", err)
	}
	if err = ValidateStagedExecutable(staging, executable, "0.3.0", state, keyring, now); err == nil {
		t.Fatal("different running version was accepted")
	}
	if err = os.WriteFile(executable, []byte("different binary"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = ValidateStagedExecutable(staging, executable, "0.2.0", state, keyring, now); err == nil {
		t.Fatal("running binary with bytes different from signed staging was accepted")
	}
}

func TestSecureManifestRejectsTamperingExpiredMetadataAndDowngrade(t *testing.T) {
	now := time.Date(2026, time.October, 31, 12, 0, 0, 0, time.UTC)
	body := []byte("signed-windows-agent")
	validRaw, public := secureFixture(t, body, now, nil)
	state, _ := InitializeSecurityState("0.1.0")
	keyring := map[string]ed25519.PublicKey{releaseKeyID: public}
	tests := []struct {
		name   string
		mutate func(*SecureManifest)
		state  SecurityState
	}{
		{"valid signature but older version", func(value *SecureManifest) { value.Version = "0.0.9"; value.MinimumAllowedVersion = "0.0.9" }, state},
		{"stale metadata version", func(value *SecureManifest) {}, SecurityState{Schema: SecurityStateSchema, InstalledVersion: "0.1.0", MinimumAllowedVersion: "0.1.0", MetadataVersion: 1}},
		{"old security epoch", func(value *SecureManifest) { value.SecurityEpoch = 1 }, SecurityState{Schema: SecurityStateSchema, InstalledVersion: "0.1.0", MinimumAllowedVersion: "0.1.0", SecurityEpoch: 2}},
		{"expired", func(value *SecureManifest) { value.ExpiresAt = now.Add(-time.Minute).Format(time.RFC3339) }, state},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw := validRaw
			if test.name == "valid signature but older version" {
				raw, _ = secureFixture(t, body, now, test.mutate)
			} else if test.name == "stale metadata version" || test.name == "old security epoch" {
				// The manifest remains correctly signed; only the persistent floor changes.
			} else {
				raw, _ = secureFixture(t, body, now, test.mutate)
			}
			if _, err := VerifySecureManifest(raw, "0.1.0", "windows", "amd64", test.state, keyring, now); err == nil {
				t.Fatal("unsafe release metadata was accepted")
			}
		})
	}
	changed, _ := DecodeSecureManifest(validRaw)
	changed.Version = "0.9.0"
	forged, _ := json.Marshal(changed)
	if _, err := VerifySecureManifest(forged, "0.1.0", "windows", "amd64", state, keyring, now); err == nil {
		t.Fatal("unsigned manifest mutation was accepted")
	}
	if _, err := VerifySecureManifest(validRaw, "0.2.0", "windows", "amd64", state, keyring, now); !errors.Is(err, ErrNoUpdate) {
		t.Fatalf("installed version should not reapply update, got %v", err)
	}
}

func TestPersistentSecurityStateEnforcesVersionAndMonotonicMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update-security-state.bin")
	state, err := LoadOrInitializeSecurityState(path, "0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.October, 31, 12, 0, 0, 0, time.UTC)
	body := []byte("signed-windows-agent")
	raw, public := secureFixture(t, body, now, nil)
	manifest, err := VerifySecureManifest(raw, "0.1.0", "windows", "amd64", state, map[string]ed25519.PublicKey{releaseKeyID: public}, now)
	if err != nil {
		t.Fatal(err)
	}
	state, err = AdvanceSecurityState(state, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = SaveSecurityState(path, state); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadOrInitializeSecurityState(path, "0.2.0")
	if err != nil || loaded.MetadataVersion != 1 || loaded.SecurityEpoch != 1 || loaded.MinimumAllowedVersion != "0.2.0" {
		t.Fatalf("persistent security state mismatch: %#v, %v", loaded, err)
	}
	if _, err = LoadOrInitializeSecurityState(path, "0.1.0"); !errors.Is(err, ErrRollback) {
		t.Fatalf("older installed agent was not blocked: %v", err)
	}
}

func TestRuntimeDoesNotCommitNewVersionBeforeUpdaterHealthCheck(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update-security-state.bin")
	initial, err := InitializeSecurityState("0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if err = SaveSecurityState(path, initial); err != nil {
		t.Fatal(err)
	}
	runtimeState, err := LoadSecurityStateForRuntime(path, "0.2.0")
	if err != nil || runtimeState.InstalledVersion != "0.1.0" {
		t.Fatalf("runtime advanced high-water before health check: %#v %v", runtimeState, err)
	}
	persisted, err := LoadSecurityState(path)
	if err != nil || persisted.InstalledVersion != "0.1.0" {
		t.Fatalf("uncommitted runtime version was persisted: %#v %v", persisted, err)
	}
	if _, err = LoadSecurityStateForRuntime(path, "0.0.9"); !errors.Is(err, ErrRollback) {
		t.Fatalf("runtime rollback was not blocked: %v", err)
	}
}

func TestRuntimeFailsClosedWhenPersistentSecurityStateIsMissing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-security-state.bin")
	if _, err := LoadSecurityStateForRuntime(path, "0.1.0"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing persistent security state was initialized implicitly: %v", err)
	}
}

func TestAtomicSecurityStateWriteReplacesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.bin")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil || string(contents) != "new" {
		t.Fatalf("atomic replacement failed: contents=%q err=%v", contents, err)
	}
}

func TestTrustKeyringRejectsMalformedAndAcceptsRawEd25519Key(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(map[string]string{releaseKeyID: base64.StdEncoding.EncodeToString(public)})
	keyring, err := ParseTrustKeyringJSON(encoded)
	if err != nil || len(keyring[releaseKeyID]) != ed25519.PublicKeySize {
		t.Fatalf("valid raw Ed25519 trust key rejected: %v", err)
	}
	if _, err = ParseTrustKeyringJSON([]byte(`{"invalid key id":"abc"}`)); err == nil {
		t.Fatal("invalid trust keyring accepted")
	}
}
