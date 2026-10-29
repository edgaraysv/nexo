package keystore

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadOrCreateKeepsStableP256Identity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device-key")
	first, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := x509.MarshalPKIXPublicKey(&first.PublicKey)
	b, _ := x509.MarshalPKIXPublicKey(&second.PublicKey)
	if string(a) != string(b) {
		t.Fatal("identity changed")
	}
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("unexpected permissions %o", info.Mode().Perm())
	}
}
