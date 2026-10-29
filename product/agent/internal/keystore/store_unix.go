//go:build !windows

package keystore

// Linux development storage relies on a dedicated 0600 file. Production must
// replace this adapter with TPM/PKCS#11 or another accepted non-exportable store.
func protect(value []byte) ([]byte, error)   { return value, nil }
func unprotect(value []byte) ([]byte, error) { return value, nil }
