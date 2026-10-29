//go:build !windows

package main

import "errors"

func newPlatformVPNLauncher() (vpnLauncher, error) {
	return nil, errors.New("managed OpenVPN is Windows-only")
}
