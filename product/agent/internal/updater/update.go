package updater

import (
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
	"strconv"
	"strings"
)

const (
	Schema         = "nexo.agent-update.v1"
	MaxPackageSize = 64 * 1024 * 1024
)

var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type Manifest struct {
	Schema                  string   `json:"schema"`
	Version                 string   `json:"version"`
	OperatingSystem         string   `json:"operating_system"`
	Architecture            string   `json:"architecture"`
	Size                    int64    `json:"size"`
	SHA256                  string   `json:"sha256"`
	MinimumCurrentVersion   string   `json:"minimum_current_version"`
	BlockedRollbackVersions []string `json:"blocked_rollback_versions"`
	Signature               string   `json:"signature"`
}

type PendingUpdate struct {
	Schema          string `json:"schema"`
	Version         string `json:"version"`
	SHA256          string `json:"sha256"`
	RollbackAllowed bool   `json:"rollback_allowed"`
	Package         string `json:"package"`
}

type signedManifest struct {
	Schema                  string   `json:"schema"`
	Version                 string   `json:"version"`
	OperatingSystem         string   `json:"operating_system"`
	Architecture            string   `json:"architecture"`
	Size                    int64    `json:"size"`
	SHA256                  string   `json:"sha256"`
	MinimumCurrentVersion   string   `json:"minimum_current_version"`
	BlockedRollbackVersions []string `json:"blocked_rollback_versions"`
}

func SigningBytes(manifest Manifest) ([]byte, error) {
	return json.Marshal(signedManifest{
		Schema: manifest.Schema, Version: manifest.Version, OperatingSystem: manifest.OperatingSystem,
		Architecture: manifest.Architecture, Size: manifest.Size, SHA256: manifest.SHA256,
		MinimumCurrentVersion: manifest.MinimumCurrentVersion, BlockedRollbackVersions: manifest.BlockedRollbackVersions,
	})
}

func VerifyAndStage(manifestJSON []byte, packageReader io.Reader, stagingDir, currentVersion, operatingSystem, architecture string, publicKey ed25519.PublicKey) (PendingUpdate, error) {
	var manifest Manifest
	decoder := json.NewDecoder(strings.NewReader(string(manifestJSON)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return PendingUpdate{}, errors.New("invalid update manifest")
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) {
		return PendingUpdate{}, errors.New("invalid update manifest")
	}
	if manifest.Schema != Schema || manifest.OperatingSystem != operatingSystem || manifest.Architecture != architecture || manifest.Size < 1 || manifest.Size > MaxPackageSize {
		return PendingUpdate{}, errors.New("incompatible update manifest")
	}
	if compareVersions(manifest.Version, currentVersion) <= 0 || compareVersions(currentVersion, manifest.MinimumCurrentVersion) < 0 {
		return PendingUpdate{}, errors.New("incompatible update version")
	}
	signature, err := base64.StdEncoding.DecodeString(manifest.Signature)
	if err != nil {
		return PendingUpdate{}, errors.New("invalid update signature")
	}
	signed, _ := SigningBytes(manifest)
	if len(publicKey) != ed25519.PublicKeySize || !ed25519.Verify(publicKey, signed, signature) {
		return PendingUpdate{}, errors.New("invalid update signature")
	}
	if err = os.MkdirAll(stagingDir, 0700); err != nil {
		return PendingUpdate{}, err
	}
	temporary, err := os.CreateTemp(stagingDir, "nexo-agent-*.pending")
	if err != nil {
		return PendingUpdate{}, err
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
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(packageReader, MaxPackageSize+1))
	if err != nil || written != manifest.Size || written > MaxPackageSize || hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(manifest.SHA256) {
		return PendingUpdate{}, errors.New("invalid update package")
	}
	if err = temporary.Sync(); err != nil {
		return PendingUpdate{}, err
	}
	if err = temporary.Close(); err != nil {
		return PendingUpdate{}, err
	}
	packageName := "nexo-agent.pending.exe"
	packagePath := filepath.Join(stagingDir, packageName)
	if err = os.Rename(temporaryName, packagePath); err != nil {
		return PendingUpdate{}, err
	}
	keep = true
	pending := PendingUpdate{Schema: Schema, Version: manifest.Version, SHA256: strings.ToLower(manifest.SHA256), RollbackAllowed: !contains(manifest.BlockedRollbackVersions, currentVersion), Package: packageName}
	state, _ := json.Marshal(pending)
	if err = os.WriteFile(filepath.Join(stagingDir, "update-state.json"), state, 0600); err != nil {
		_ = os.Remove(packagePath)
		return PendingUpdate{}, err
	}
	return pending, nil
}

func compareVersions(left, right string) int {
	a, okA := parseVersion(left)
	b, okB := parseVersion(right)
	if !okA || !okB {
		return -2
	}
	for index := range a {
		if a[index] < b[index] {
			return -1
		}
		if a[index] > b[index] {
			return 1
		}
	}
	return 0
}

func parseVersion(value string) ([3]int, bool) {
	match := versionPattern.FindStringSubmatch(value)
	if match == nil {
		return [3]int{}, false
	}
	var result [3]int
	for index := range result {
		parsed, err := strconv.Atoi(match[index+1])
		if err != nil {
			return [3]int{}, false
		}
		result[index] = parsed
	}
	return result, true
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func ValidatePendingPackage(stagingDir string, pending PendingUpdate) error {
	if pending.Schema != Schema || pending.Package != "nexo-agent.pending.exe" || !versionPattern.MatchString(pending.Version) {
		return errors.New("invalid pending update")
	}
	packagePath := filepath.Join(stagingDir, pending.Package)
	file, err := os.Open(packagePath)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, MaxPackageSize+1))
	if err != nil || written > MaxPackageSize || hex.EncodeToString(hash.Sum(nil)) != pending.SHA256 {
		return fmt.Errorf("pending update integrity failure")
	}
	return nil
}
