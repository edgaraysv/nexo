//go:build !windows

package main

import (
	"errors"
	"net/netip"
)

func hasIPv4Route(netip.Addr) (bool, error) {
	return false, errors.New("local route observation is only implemented on Windows")
}
