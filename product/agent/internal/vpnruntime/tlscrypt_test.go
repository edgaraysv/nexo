package vpnruntime

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"strings"
	"testing"
)

func TestTLSCryptEnvelopeIsRecipientAndEnvironmentBound(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	environmentID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	plain := []byte("-----BEGIN OpenVPN Static key V1-----\n" + strings.Repeat("ab", 256) + "\n-----END OpenVPN Static key V1-----\n")
	envelope, err := EncryptTLSCryptKey(&key.PublicKey, environmentID, plain)
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := DecryptTLSCryptKey(key, environmentID, envelope)
	if err != nil || string(decrypted) != string(plain) {
		t.Fatalf("decrypt mismatch err=%v", err)
	}
	if _, err = DecryptTLSCryptKey(key, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", envelope); err == nil {
		t.Fatal("envelope accepted for another environment")
	}
	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = DecryptTLSCryptKey(other, environmentID, envelope); err == nil {
		t.Fatal("envelope accepted for another endpoint")
	}
	if _, err = EncryptTLSCryptKey(&key.PublicKey, environmentID, []byte("not a static key")); err == nil {
		t.Fatal("invalid static key accepted")
	}
}
