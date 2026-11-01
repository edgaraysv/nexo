package updater

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"nexo.local/agent/internal/keystore"
)

const (
	SecureSchema        = "nexo.agent-update.v2"
	SecurityStateSchema = "nexo.agent-update-security-state.v1"
	MaxManifestSize     = 32 * 1024
	MaxManifestAge      = 180 * 24 * time.Hour
)

var (
	ErrNoUpdate      = errors.New("no newer agent release")
	ErrRollback      = errors.New("agent rollback detected")
	versionV2Pattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	keyIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`)
	hashPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// EmbeddedTrustKeysB64 is populated at release build time with base64-encoded
// JSON: {"release-key-id":"<base64 raw Ed25519 public key>"}. It contains
// public trust anchors only; no signing key is compiled into the agent.
var EmbeddedTrustKeysB64 string

type SecureManifest struct {
	Schema                  string   `json:"schema"`
	Version                 string   `json:"version"`
	OperatingSystem         string   `json:"operating_system"`
	Architecture            string   `json:"architecture"`
	Size                    int64    `json:"size"`
	SHA256                  string   `json:"sha256"`
	MinimumCurrentVersion   string   `json:"minimum_current_version"`
	MinimumAllowedVersion   string   `json:"minimum_allowed_version"`
	MetadataVersion         uint64   `json:"metadata_version"`
	SecurityEpoch           uint64   `json:"security_epoch"`
	BlockedRollbackVersions []string `json:"blocked_rollback_versions"`
	KeyID                   string   `json:"key_id"`
	IssuedAt                string   `json:"issued_at"`
	ExpiresAt               string   `json:"expires_at"`
	Signature               string   `json:"signature"`
}

type secureSignedManifest struct {
	Schema                  string   `json:"schema"`
	Version                 string   `json:"version"`
	OperatingSystem         string   `json:"operating_system"`
	Architecture            string   `json:"architecture"`
	Size                    int64    `json:"size"`
	SHA256                  string   `json:"sha256"`
	MinimumCurrentVersion   string   `json:"minimum_current_version"`
	MinimumAllowedVersion   string   `json:"minimum_allowed_version"`
	MetadataVersion         uint64   `json:"metadata_version"`
	SecurityEpoch           uint64   `json:"security_epoch"`
	BlockedRollbackVersions []string `json:"blocked_rollback_versions"`
	KeyID                   string   `json:"key_id"`
	IssuedAt                string   `json:"issued_at"`
	ExpiresAt               string   `json:"expires_at"`
}

type SecurityState struct {
	Schema                string `json:"schema"`
	InstalledVersion      string `json:"installed_version"`
	MinimumAllowedVersion string `json:"minimum_allowed_version"`
	MetadataVersion       uint64 `json:"metadata_version"`
	SecurityEpoch         uint64 `json:"security_epoch"`
	InstalledSHA256       string `json:"installed_sha256,omitempty"`
}

type StagedRelease struct {
	Schema          string `json:"schema"`
	Version         string `json:"version"`
	SHA256          string `json:"sha256"`
	RollbackAllowed bool   `json:"rollback_allowed"`
	Package         string `json:"package"`
}

// SigningBytesV2 returns the exact RAW bytes passed to KMS Sign with
// ED25519_SHA_512. Keep the field order stable for the Node.js release signer.
func SigningBytesV2(manifest SecureManifest) ([]byte, error) {
	blockedVersions := manifest.BlockedRollbackVersions
	if blockedVersions == nil {
		blockedVersions = []string{}
	}
	return json.Marshal(secureSignedManifest{
		Schema: manifest.Schema, Version: manifest.Version,
		OperatingSystem: manifest.OperatingSystem, Architecture: manifest.Architecture,
		Size: manifest.Size, SHA256: manifest.SHA256,
		MinimumCurrentVersion: manifest.MinimumCurrentVersion,
		MinimumAllowedVersion: manifest.MinimumAllowedVersion,
		MetadataVersion:       manifest.MetadataVersion, SecurityEpoch: manifest.SecurityEpoch,
		BlockedRollbackVersions: blockedVersions,
		KeyID:                   manifest.KeyID, IssuedAt: manifest.IssuedAt, ExpiresAt: manifest.ExpiresAt,
	})
}

func ParseTrustKeyringJSON(encoded []byte) (map[string]ed25519.PublicKey, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var values map[string]string
	if err := decoder.Decode(&values); err != nil || len(values) == 0 {
		return nil, errors.New("invalid update trust keyring")
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) {
		return nil, errors.New("invalid update trust keyring")
	}
	keys := make(map[string]ed25519.PublicKey, len(values))
	for id, value := range values {
		if !keyIDPattern.MatchString(id) {
			return nil, errors.New("invalid update trust key id")
		}
		publicKey, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(publicKey) != ed25519.PublicKeySize {
			return nil, errors.New("invalid update trust public key")
		}
		keys[id] = ed25519.PublicKey(append([]byte(nil), publicKey...))
	}
	return keys, nil
}

func EmbeddedTrustKeyring() (map[string]ed25519.PublicKey, error) {
	if EmbeddedTrustKeysB64 == "" {
		return nil, nil
	}
	encoded, err := base64.StdEncoding.DecodeString(EmbeddedTrustKeysB64)
	if err != nil {
		return nil, errors.New("invalid embedded update trust keyring")
	}
	return ParseTrustKeyringJSON(encoded)
}

func DecodeSecureManifest(raw []byte) (SecureManifest, error) {
	var manifest SecureManifest
	if len(raw) == 0 || len(raw) > MaxManifestSize {
		return manifest, errors.New("invalid update manifest size")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return SecureManifest{}, errors.New("invalid update manifest")
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) {
		return SecureManifest{}, errors.New("invalid update manifest")
	}
	return manifest, nil
}

func VerifySecureManifest(raw []byte, currentVersion, operatingSystem, architecture string, state SecurityState, keyring map[string]ed25519.PublicKey, now time.Time) (SecureManifest, error) {
	manifest, err := DecodeSecureManifest(raw)
	if err != nil {
		return SecureManifest{}, err
	}
	if err = validateSecurityState(state); err != nil {
		return SecureManifest{}, err
	}
	if manifest.Schema != SecureSchema || manifest.OperatingSystem != operatingSystem || manifest.Architecture != architecture || manifest.Size < 1 || manifest.Size > MaxPackageSize || !hashPattern.MatchString(manifest.SHA256) || !keyIDPattern.MatchString(manifest.KeyID) {
		return SecureManifest{}, errors.New("incompatible update manifest")
	}
	if !versionV2Pattern.MatchString(manifest.Version) || !versionV2Pattern.MatchString(manifest.MinimumCurrentVersion) || !versionV2Pattern.MatchString(manifest.MinimumAllowedVersion) || !versionV2Pattern.MatchString(currentVersion) {
		return SecureManifest{}, errors.New("invalid update version")
	}
	if manifest.MetadataVersion == 0 || manifest.SecurityEpoch == 0 || len(manifest.BlockedRollbackVersions) > 256 {
		return SecureManifest{}, errors.New("invalid update security metadata")
	}
	for _, version := range manifest.BlockedRollbackVersions {
		if !versionV2Pattern.MatchString(version) {
			return SecureManifest{}, errors.New("invalid blocked rollback version")
		}
	}
	issuedAt, issuedErr := time.Parse(time.RFC3339, manifest.IssuedAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339, manifest.ExpiresAt)
	if issuedErr != nil || expiresErr != nil || !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > MaxManifestAge || issuedAt.After(now.Add(5*time.Minute)) || !expiresAt.After(now) {
		return SecureManifest{}, errors.New("expired or invalid update metadata")
	}
	publicKey, exists := keyring[manifest.KeyID]
	if !exists || len(publicKey) != ed25519.PublicKeySize {
		return SecureManifest{}, errors.New("untrusted update signing key")
	}
	signature, err := base64.StdEncoding.DecodeString(manifest.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return SecureManifest{}, errors.New("invalid update signature")
	}
	signed, err := SigningBytesV2(manifest)
	if err != nil || !ed25519.Verify(publicKey, signed, signature) {
		return SecureManifest{}, errors.New("invalid update signature")
	}
	if compareVersions(currentVersion, state.MinimumAllowedVersion) < 0 || compareVersions(currentVersion, state.InstalledVersion) < 0 {
		return SecureManifest{}, ErrRollback
	}
	if compareVersions(currentVersion, manifest.MinimumCurrentVersion) < 0 || compareVersions(manifest.Version, manifest.MinimumAllowedVersion) < 0 {
		return SecureManifest{}, errors.New("incompatible update version")
	}
	if manifest.MetadataVersion < state.MetadataVersion || manifest.SecurityEpoch < state.SecurityEpoch || compareVersions(manifest.MinimumAllowedVersion, state.MinimumAllowedVersion) < 0 {
		return SecureManifest{}, errors.New("update metadata rollback rejected")
	}
	comparison := compareVersions(manifest.Version, currentVersion)
	if manifest.MetadataVersion == state.MetadataVersion && !(comparison == 0 && state.InstalledSHA256 != "" && strings.EqualFold(manifest.SHA256, state.InstalledSHA256) && manifest.SecurityEpoch == state.SecurityEpoch && manifest.MinimumAllowedVersion == state.MinimumAllowedVersion) {
		return SecureManifest{}, errors.New("update metadata replay rejected")
	}
	if comparison <= 0 {
		if comparison < 0 {
			return SecureManifest{}, errors.New("update downgrade rejected")
		}
		if state.InstalledSHA256 != "" && !strings.EqualFold(manifest.SHA256, state.InstalledSHA256) {
			return SecureManifest{}, errors.New("installed release hash conflicts with signed metadata")
		}
		return manifest, ErrNoUpdate
	}
	return manifest, nil
}

func InitializeSecurityState(version string) (SecurityState, error) {
	if !versionV2Pattern.MatchString(version) {
		return SecurityState{}, errors.New("invalid installed agent version")
	}
	return SecurityState{Schema: SecurityStateSchema, InstalledVersion: version, MinimumAllowedVersion: version}, nil
}

func LoadOrInitializeSecurityState(path, currentVersion string) (SecurityState, error) {
	state, err := LoadSecurityState(path)
	if errors.Is(err, os.ErrNotExist) {
		state, err = InitializeSecurityState(currentVersion)
		if err != nil {
			return SecurityState{}, err
		}
		if err = SaveSecurityState(path, state); err != nil {
			return SecurityState{}, err
		}
		return state, nil
	}
	if err != nil {
		return SecurityState{}, err
	}
	if err = validateSecurityState(state); err != nil {
		return SecurityState{}, err
	}
	if !versionV2Pattern.MatchString(currentVersion) || currentVersion != state.InstalledVersion || compareVersions(currentVersion, state.MinimumAllowedVersion) < 0 {
		return SecurityState{}, ErrRollback
	}
	return state, nil
}

// LoadSecurityStateForRuntime fails closed if persistent state is missing and
// never advances the installed high-water mark. The installer initializes a
// new installation explicitly; the privileged updater commits a candidate
// version only after SCM and IPC health checks pass.
func LoadSecurityStateForRuntime(path, currentVersion string) (SecurityState, error) {
	state, err := LoadSecurityState(path)
	if err != nil {
		return SecurityState{}, err
	}
	if !versionV2Pattern.MatchString(currentVersion) || compareVersions(currentVersion, state.InstalledVersion) < 0 || compareVersions(currentVersion, state.MinimumAllowedVersion) < 0 {
		return SecurityState{}, ErrRollback
	}
	return state, nil
}

func LoadSecurityState(path string) (SecurityState, error) {
	var state SecurityState
	encoded, err := os.ReadFile(path)
	if err != nil {
		return state, err
	}
	plain, err := keystore.UnprotectMachine(encoded)
	if err != nil {
		return state, errors.New("update security state unavailable")
	}
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&state); err != nil {
		return SecurityState{}, errors.New("update security state unavailable")
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) {
		return SecurityState{}, errors.New("update security state unavailable")
	}
	if err = validateSecurityState(state); err != nil {
		return SecurityState{}, errors.New("update security state unavailable")
	}
	return state, nil
}

func SaveSecurityState(path string, state SecurityState) error {
	if err := validateSecurityState(state); err != nil {
		return err
	}
	plain, err := json.Marshal(state)
	if err != nil {
		return err
	}
	protected, err := keystore.ProtectMachine(plain)
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".update-security-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0600); err == nil {
		_, err = temporary.Write(protected)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = replaceAtomicFile(name, path); err != nil {
		return err
	}
	return nil
}

func AdvanceSecurityState(state SecurityState, manifest SecureManifest) (SecurityState, error) {
	if err := validateSecurityState(state); err != nil {
		return SecurityState{}, err
	}
	if manifest.Schema != SecureSchema || !versionV2Pattern.MatchString(manifest.Version) || !versionV2Pattern.MatchString(manifest.MinimumAllowedVersion) || !hashPattern.MatchString(manifest.SHA256) || manifest.MetadataVersion == 0 || manifest.SecurityEpoch == 0 || manifest.MetadataVersion <= state.MetadataVersion || manifest.SecurityEpoch < state.SecurityEpoch || compareVersions(manifest.MinimumAllowedVersion, state.MinimumAllowedVersion) < 0 || compareVersions(manifest.Version, state.MinimumAllowedVersion) < 0 {
		return SecurityState{}, errors.New("invalid update security-state transition")
	}
	return SecurityState{
		Schema: SecurityStateSchema, InstalledVersion: manifest.Version,
		MinimumAllowedVersion: manifest.MinimumAllowedVersion,
		MetadataVersion:       manifest.MetadataVersion, SecurityEpoch: manifest.SecurityEpoch,
		InstalledSHA256: strings.ToLower(manifest.SHA256),
	}, nil
}

func AdvanceMetadataState(state SecurityState, manifest SecureManifest) (SecurityState, error) {
	if err := validateSecurityState(state); err != nil {
		return SecurityState{}, err
	}
	if manifest.Schema != SecureSchema || manifest.Version != state.InstalledVersion || manifest.MetadataVersion <= state.MetadataVersion || manifest.SecurityEpoch < state.SecurityEpoch || compareVersions(manifest.MinimumAllowedVersion, state.MinimumAllowedVersion) < 0 || compareVersions(manifest.MinimumAllowedVersion, state.InstalledVersion) > 0 {
		return SecurityState{}, errors.New("invalid update metadata-state transition")
	}
	state.MetadataVersion = manifest.MetadataVersion
	state.SecurityEpoch = manifest.SecurityEpoch
	state.MinimumAllowedVersion = manifest.MinimumAllowedVersion
	return state, nil
}

func StageSecureRelease(raw []byte, packageReader io.Reader, stagingDir, currentVersion, operatingSystem, architecture string, state SecurityState, keyring map[string]ed25519.PublicKey, now time.Time) (StagedRelease, SecureManifest, error) {
	manifest, err := VerifySecureManifest(raw, currentVersion, operatingSystem, architecture, state, keyring, now)
	if err != nil {
		return StagedRelease{}, SecureManifest{}, err
	}
	if err = os.MkdirAll(stagingDir, 0700); err != nil {
		return StagedRelease{}, SecureManifest{}, err
	}
	temporary, err := os.CreateTemp(stagingDir, ".nexo-agent-*.pending")
	if err != nil {
		return StagedRelease{}, SecureManifest{}, err
	}
	temporaryName := temporary.Name()
	keep := false
	defer func() {
		_ = temporary.Close()
		if !keep {
			_ = os.Remove(temporaryName)
		}
	}()
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(packageReader, MaxPackageSize+1))
	if copyErr != nil || written != manifest.Size || written > MaxPackageSize || hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(manifest.SHA256) {
		return StagedRelease{}, SecureManifest{}, errors.New("invalid update package")
	}
	if err = temporary.Sync(); err != nil {
		return StagedRelease{}, SecureManifest{}, err
	}
	if err = temporary.Close(); err != nil {
		return StagedRelease{}, SecureManifest{}, err
	}
	packageName := "nexo-agent.pending.exe"
	packagePath := filepath.Join(stagingDir, packageName)
	manifestPath := filepath.Join(stagingDir, "nexo-agent.pending.json")
	statePath := filepath.Join(stagingDir, "update-state.json")
	for _, path := range []string{packagePath, manifestPath, statePath} {
		if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return StagedRelease{}, SecureManifest{}, err
		}
	}
	if err = os.Rename(temporaryName, packagePath); err != nil {
		return StagedRelease{}, SecureManifest{}, err
	}
	keep = true
	if err = atomicWrite(manifestPath, raw); err != nil {
		_ = os.Remove(packagePath)
		return StagedRelease{}, SecureManifest{}, err
	}
	pending := StagedRelease{
		Schema: SecureSchema, Version: manifest.Version, SHA256: strings.ToLower(manifest.SHA256),
		RollbackAllowed: rollbackAllowed(currentVersion, manifest), Package: packageName,
	}
	encoded, _ := json.Marshal(pending)
	if err = atomicWrite(statePath, encoded); err != nil {
		_ = os.Remove(packagePath)
		_ = os.Remove(manifestPath)
		return StagedRelease{}, SecureManifest{}, err
	}
	return pending, manifest, nil
}

func ValidateStagedSecureRelease(stagingDir string, state SecurityState, keyring map[string]ed25519.PublicKey, now time.Time) (SecureManifest, StagedRelease, error) {
	manifestPath := filepath.Join(stagingDir, "nexo-agent.pending.json")
	raw, err := readRegularFile(manifestPath, MaxManifestSize)
	if err != nil {
		return SecureManifest{}, StagedRelease{}, err
	}
	manifest, err := VerifySecureManifest(raw, state.InstalledVersion, "windows", "amd64", state, keyring, now)
	if err != nil {
		return SecureManifest{}, StagedRelease{}, err
	}
	stateRaw, err := readRegularFile(filepath.Join(stagingDir, "update-state.json"), 4096)
	if err != nil {
		return SecureManifest{}, StagedRelease{}, err
	}
	var pending StagedRelease
	decoder := json.NewDecoder(bytes.NewReader(stateRaw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&pending); err != nil || pending.Schema != SecureSchema || pending.Package != "nexo-agent.pending.exe" || pending.Version != manifest.Version || pending.SHA256 != strings.ToLower(manifest.SHA256) {
		return SecureManifest{}, StagedRelease{}, errors.New("invalid pending update")
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) {
		return SecureManifest{}, StagedRelease{}, errors.New("invalid pending update")
	}
	// Rollback authority comes only from the signed manifest and installed floor,
	// never from the mutable staging JSON.
	pending.RollbackAllowed = rollbackAllowed(state.InstalledVersion, manifest)
	packagePath := filepath.Join(stagingDir, pending.Package)
	file, err := os.Open(packagePath)
	if err != nil {
		return SecureManifest{}, StagedRelease{}, err
	}
	defer file.Close()
	hash := sha256.New()
	written, copyErr := io.Copy(hash, io.LimitReader(file, MaxPackageSize+1))
	if copyErr != nil || written != manifest.Size || written > MaxPackageSize || hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(manifest.SHA256) {
		return SecureManifest{}, StagedRelease{}, errors.New("pending update integrity failure")
	}
	return manifest, pending, nil
}

func ValidateStagedExecutable(stagingDir, executablePath, runningVersion string, state SecurityState, keyring map[string]ed25519.PublicKey, now time.Time) error {
	manifest, _, err := ValidateStagedSecureRelease(stagingDir, state, keyring, now)
	if err != nil {
		return err
	}
	if manifest.Version != runningVersion || runningVersion == state.InstalledVersion {
		return errors.New("running agent is not the pending signed version")
	}
	return VerifyAgentFile(executablePath, manifest.SHA256, manifest.Size)
}

func VerifyAgentFile(path, expectedSHA256 string, expectedSize int64) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != expectedSize || expectedSize < 1 || expectedSize > MaxPackageSize || !hashPattern.MatchString(expectedSHA256) {
		return errors.New("running agent file is not the signed package")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	written, err := io.Copy(digest, io.LimitReader(file, MaxPackageSize+1))
	if err != nil || written != expectedSize || hex.EncodeToString(digest.Sum(nil)) != expectedSHA256 {
		return errors.New("running agent hash does not match signed metadata")
	}
	return nil
}

func validateSecurityState(state SecurityState) error {
	if state.Schema != SecurityStateSchema || !versionV2Pattern.MatchString(state.InstalledVersion) || !versionV2Pattern.MatchString(state.MinimumAllowedVersion) || compareVersions(state.MinimumAllowedVersion, state.InstalledVersion) > 0 || state.InstalledSHA256 != "" && !hashPattern.MatchString(state.InstalledSHA256) {
		return errors.New("invalid update security state")
	}
	return nil
}

func rollbackAllowed(currentVersion string, manifest SecureManifest) bool {
	return compareVersions(currentVersion, manifest.MinimumAllowedVersion) >= 0 && !contains(manifest.BlockedRollbackVersions, currentVersion)
}

func atomicWrite(path string, contents []byte) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".nexo-update-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0600); err == nil {
		_, err = temporary.Write(contents)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceAtomicFile(name, path)
}

func readRegularFile(path string, max int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > max {
		return nil, fmt.Errorf("invalid update file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, max+1))
}
