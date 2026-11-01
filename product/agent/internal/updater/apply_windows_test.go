//go:build windows

package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceFileAtomicallyReplacesExistingWindowsBinary(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "candidate.exe")
	active := filepath.Join(directory, "nexo-agent.exe")
	candidate := []byte("new verified windows agent")
	if err := os.WriteFile(source, candidate, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(active, []byte("old agent"), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(candidate)
	if err := replaceFile(source, active, hex.EncodeToString(digest[:]), int64(len(candidate))); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(active)
	if err != nil || string(contents) != string(candidate) {
		t.Fatalf("active binary was not replaced: contents=%q err=%v", contents, err)
	}
	if matched, err := fileMatches(active, hex.EncodeToString(digest[:]), int64(len(candidate))); err != nil || !matched {
		t.Fatalf("replaced candidate failed hash check: matched=%v err=%v", matched, err)
	}
}

func TestReplaceFileRejectsHashMismatchWithoutChangingActiveBinary(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "candidate.exe")
	active := filepath.Join(directory, "nexo-agent.exe")
	if err := os.WriteFile(source, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(active, []byte("old agent"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceFile(source, active, "0000000000000000000000000000000000000000000000000000000000000000", int64(len("tampered"))); err == nil {
		t.Fatal("candidate with mismatched hash was accepted")
	}
	contents, err := os.ReadFile(active)
	if err != nil || string(contents) != "old agent" {
		t.Fatalf("hash failure altered active binary: contents=%q err=%v", contents, err)
	}
}
