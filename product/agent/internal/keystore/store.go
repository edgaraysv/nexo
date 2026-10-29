package keystore

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
)

func LoadOrCreate(path string) (*ecdsa.PrivateKey, error) {
	if encoded, err := os.ReadFile(path); err == nil {
		plain, err := unprotect(encoded)
		if err != nil {
			return nil, err
		}
		block, _ := pem.Decode(plain)
		if block == nil {
			return nil, errors.New("invalid private key")
		}
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		ec, ok := key.(*ecdsa.PrivateKey)
		if !ok || ec.Curve != elliptic.P256() {
			return nil, errors.New("unexpected key type")
		}
		return ec, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	encoded, err := protect(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(dir(path), 0700); err != nil {
		return nil, err
	}
	if err = os.WriteFile(path, encoded, 0600); err != nil {
		return nil, err
	}
	return key, nil
}
func PublicPEM(key *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}
func dir(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			if i == 0 {
				return string(path[0])
			}
			return path[:i]
		}
	}
	return "."
}
