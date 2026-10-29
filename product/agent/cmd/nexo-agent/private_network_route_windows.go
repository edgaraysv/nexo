//go:build windows

package main

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func hasIPv4Route(address netip.Addr) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	executable := "route"
	if systemRoot := os.Getenv("SystemRoot"); systemRoot != "" {
		executable = filepath.Join(systemRoot, "System32", "route.exe")
	}
	output, err := exec.CommandContext(ctx, executable, "print", "-4").Output()
	if ctx.Err() != nil {
		return false, errors.New("route table command timed out")
	}
	if err != nil {
		return false, errors.New("route table unavailable")
	}
	return containsIPv4Route(parseWindowsIPv4Routes(string(output)), address), nil
}
