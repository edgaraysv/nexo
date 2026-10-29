//go:build !windows

package main

import (
	"crypto/ecdsa"
	"fmt"
)

func runWindowsService(_, _, _ string, _ *ecdsa.PrivateKey) error {
	return fmt.Errorf("windows-service is only available on Windows")
}
