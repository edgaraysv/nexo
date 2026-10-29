package updater

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func signedFixture(t *testing.T, body []byte, mutate func(*Manifest)) ([]byte, ed25519.PublicKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(body)
	manifest := Manifest{Schema: Schema, Version: "0.2.0", OperatingSystem: "windows", Architecture: "amd64", Size: int64(len(body)), SHA256: hex.EncodeToString(hash[:]), MinimumCurrentVersion: "0.1.0"}
	if mutate != nil {
		mutate(&manifest)
	}
	signed, _ := SigningBytes(manifest)
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, signed))
	encoded, _ := json.Marshal(manifest)
	return encoded, public
}

func TestVerifyAndStageKeepsCurrentBinaryUntouched(t *testing.T) {
	body := []byte("signed-windows-binary")
	manifest, public := signedFixture(t, body, nil)
	dir := t.TempDir()
	pending, err := VerifyAndStage(manifest, bytes.NewReader(body), dir, "0.1.0", "windows", "amd64", public)
	if err != nil {
		t.Fatal(err)
	}
	if !pending.RollbackAllowed || pending.Package != "nexo-agent.pending.exe" {
		t.Fatalf("unexpected pending update: %#v", pending)
	}
	if err = ValidatePendingPackage(dir, pending); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(dir, "nexo-agent.exe")); !os.IsNotExist(err) {
		t.Fatal("staging replaced the active binary")
	}
}

func TestVerifyAndStageRejectsWrongKeyTamperDowngradeAndIncompatibleRuntime(t *testing.T) {
	body := []byte("signed-windows-binary")
	manifest, public := signedFixture(t, body, nil)
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	tests := []struct {
		name     string
		manifest []byte
		body     []byte
		current  string
		os       string
		key      ed25519.PublicKey
	}{
		{"wrong key", manifest, body, "0.1.0", "windows", other},
		{"tamper", manifest, []byte("tampered-windows-binary"), "0.1.0", "windows", public},
		{"downgrade", manifest, body, "0.3.0", "windows", public},
		{"wrong os", manifest, body, "0.1.0", "linux", public},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := VerifyAndStage(test.manifest, bytes.NewReader(test.body), t.TempDir(), test.current, test.os, "amd64", test.key); err == nil {
				t.Fatal("unsafe update accepted")
			}
		})
	}
}

func TestBlockedCurrentVersionDisablesRollback(t *testing.T) {
	body := []byte("signed-windows-binary")
	manifest, public := signedFixture(t, body, func(value *Manifest) { value.BlockedRollbackVersions = []string{"0.1.0"} })
	pending, err := VerifyAndStage(manifest, bytes.NewReader(body), t.TempDir(), "0.1.0", "windows", "amd64", public)
	if err != nil {
		t.Fatal(err)
	}
	if pending.RollbackAllowed {
		t.Fatal("blocked version was allowed as rollback")
	}
}
