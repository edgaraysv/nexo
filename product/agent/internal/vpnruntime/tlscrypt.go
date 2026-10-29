package vpnruntime

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type tlsCryptEnvelope struct {
	Version    string `json:"version"`
	Ephemeral  string `json:"ephemeral_public_key"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// EncryptTLSCryptKey binds an OpenVPN static key to the P-256 key in the
// endpoint's authenticated CSR. The control plane can retain the envelope,
// but cannot recover the static key.
func EncryptTLSCryptKey(publicKey *ecdsa.PublicKey, environmentID string, staticKey []byte) (string, error) {
	if publicKey == nil || publicKey.Curve != ecdsaCurveP256() || !ValidEnvironmentID(environmentID) || !validStaticKey(staticKey) {
		return "", errors.New("invalid tls crypt key input")
	}
	peer, err := ecdh.P256().NewPublicKey(elliptic.Marshal(elliptic.P256(), publicKey.X, publicKey.Y))
	if err != nil {
		return "", errors.New("invalid tls crypt recipient")
	}
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	shared, err := ephemeral.ECDH(peer)
	if err != nil {
		return "", errors.New("tls crypt key agreement failed")
	}
	key := deriveTLSCryptKey(shared, ephemeral.PublicKey().Bytes(), peer.Bytes())
	aead, err := newTLSCryptAEAD(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	aad := []byte("nexo-f07-tls-crypt-v1:" + environmentID)
	envelope := tlsCryptEnvelope{Version: "v1", Ephemeral: base64.RawURLEncoding.EncodeToString(ephemeral.PublicKey().Bytes()), Nonce: base64.RawURLEncoding.EncodeToString(nonce), Ciphertext: base64.RawURLEncoding.EncodeToString(aead.Seal(nil, nonce, staticKey, aad))}
	raw, err := json.Marshal(envelope)
	return string(raw), err
}

// DecryptTLSCryptKey is used only by the endpoint service and validates the
// environment-bound envelope before exposing bytes to the transient runtime.
func DecryptTLSCryptKey(privateKey *ecdsa.PrivateKey, environmentID, encoded string) ([]byte, error) {
	if privateKey == nil || privateKey.Curve != ecdsaCurveP256() || !ValidEnvironmentID(environmentID) || len(encoded) > 4096 {
		return nil, errors.New("invalid tls crypt envelope")
	}
	var envelope tlsCryptEnvelope
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || envelope.Version != "v1" {
		return nil, errors.New("invalid tls crypt envelope")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, errors.New("invalid tls crypt envelope")
	}
	ephemeralBytes, e1 := base64.RawURLEncoding.DecodeString(envelope.Ephemeral)
	nonce, e2 := base64.RawURLEncoding.DecodeString(envelope.Nonce)
	ciphertext, e3 := base64.RawURLEncoding.DecodeString(envelope.Ciphertext)
	if e1 != nil || e2 != nil || e3 != nil || len(ephemeralBytes) != 65 || len(ciphertext) > 2048 {
		return nil, errors.New("invalid tls crypt envelope")
	}
	curvePrivate, err := privateKey.ECDH()
	if err != nil {
		return nil, errors.New("invalid tls crypt recipient")
	}
	ephemeral, err := ecdh.P256().NewPublicKey(ephemeralBytes)
	if err != nil {
		return nil, errors.New("invalid tls crypt ephemeral key")
	}
	shared, err := curvePrivate.ECDH(ephemeral)
	if err != nil {
		return nil, errors.New("tls crypt key agreement failed")
	}
	key := deriveTLSCryptKey(shared, ephemeralBytes, curvePrivate.PublicKey().Bytes())
	aead, err := newTLSCryptAEAD(key)
	if err != nil || len(nonce) != aead.NonceSize() {
		return nil, errors.New("invalid tls crypt nonce")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, []byte("nexo-f07-tls-crypt-v1:"+environmentID))
	if err != nil || !validStaticKey(plaintext) {
		return nil, errors.New("invalid tls crypt ciphertext")
	}
	return plaintext, nil
}

func deriveTLSCryptKey(shared, ephemeral, recipient []byte) []byte {
	mac := hmac.New(sha256.New, make([]byte, sha256.Size))
	_, _ = mac.Write(shared)
	prk := mac.Sum(nil)
	mac = hmac.New(sha256.New, prk)
	_, _ = mac.Write([]byte("nexo-f07-tls-crypt-v1"))
	_, _ = mac.Write(ephemeral)
	_, _ = mac.Write(recipient)
	_, _ = mac.Write([]byte{1})
	return mac.Sum(nil)
}

func validStaticKey(value []byte) bool {
	text := strings.TrimSpace(string(value))
	text = strings.TrimPrefix(text, "-----BEGIN OpenVPN Static key V1-----")
	text = strings.TrimSuffix(text, "-----END OpenVPN Static key V1-----")
	decoded, err := hex.DecodeString(strings.Join(strings.Fields(text), ""))
	return err == nil && len(decoded) == 256
}

func ecdsaCurveP256() elliptic.Curve { return elliptic.P256() }
func newTLSCryptAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
