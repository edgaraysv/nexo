// Command nexo-crl-probe is a test-only harness that proves a revoked VPN
// client credential is rejected by the environment's OpenVPN server.
//
// It never talks to the control plane and never alters managed agent state: it
// reads a protected snapshot of the credential material, decrypts the
// tls-crypt envelope with the CSR's DPAPI-protected VPN key, writes short-lived
// runtime files inside the same protected snapshot, and runs a separate
// OpenVPN process with CA verification, server identity pinning and tls-crypt
// enabled. All security controls of the managed client are preserved.
package main

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"nexo.local/agent/internal/keystore"
	"nexo.local/agent/internal/vpnruntime"
)

var environmentIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var hostPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)

type verdict struct {
	Connected bool   `json:"connected"`
	Revoked   bool   `json:"revoked"`
	ExitCode  int    `json:"exit_code"`
	Lines     int    `json:"lines"`
	Detail    string `json:"detail,omitempty"`
}

func main() {
	state := flag.String("state", "", "agent state directory holding the DPAPI device key")
	environment := flag.String("environment", "", "VPN environment UUID")
	remote := flag.String("remote", "", "environment public IPv4 or hostname")
	port := flag.Int("port", 0, "UDP listener port")
	snapshot := flag.String("snapshot", "", "protected directory with the credential snapshot")
	logPath := flag.String("log", "", "file that receives the OpenVPN output")
	timeout := flag.Duration("timeout", 45*time.Second, "maximum runtime of the probe")
	flag.Parse()

	result, err := run(*state, *environment, *remote, *port, *snapshot, *logPath, *timeout)
	encoded, _ := json.Marshal(result)
	fmt.Println(string(encoded))
	if err != nil {
		os.Exit(2)
	}
	if result.ExitCode == 0 {
		os.Exit(1)
	}
}

func run(state, environment, remote string, port int, snapshot, logPath string, timeout time.Duration) (verdict, error) {
	var result verdict
	if !environmentIDPattern.MatchString(environment) {
		return result, errors.New("invalid environment id")
	}
	if !hostPattern.MatchString(remote) {
		return result, errors.New("invalid remote host")
	}
	if port < 1024 || port > 65535 {
		return result, errors.New("invalid remote port")
	}
	for _, directory := range []string{snapshot} {
		info, err := os.Stat(directory)
		if err != nil || !info.IsDir() {
			return result, errors.New("protected directory unavailable")
		}
	}
	// The tls-crypt envelope is bound to the per-environment VPN client key
	// (the CSR key), not to the device identity key.
	snapshotKey, err := keystore.LoadOrCreate(filepath.Join(snapshot, "client.key"))
	if err != nil {
		return result, errors.New("snapshot private key unavailable")
	}
	certificatePEM, err := os.ReadFile(filepath.Join(snapshot, "client.crt"))
	if err != nil {
		return result, errors.New("snapshot certificate unavailable")
	}
	caPEM, err := os.ReadFile(filepath.Join(snapshot, "ca.crt"))
	if err != nil {
		return result, errors.New("snapshot CA unavailable")
	}
	envelope, err := os.ReadFile(filepath.Join(snapshot, "tls-crypt.envelope"))
	if err != nil {
		return result, errors.New("snapshot tls-crypt envelope unavailable")
	}
	staticKey, err := vpnruntime.DecryptTLSCryptKey(snapshotKey, environment, string(envelope))
	if err != nil {
		return result, errors.New("tls-crypt envelope rejected")
	}
	runtimeDirectory := filepath.Join(snapshot, "runtime")
	if err = os.MkdirAll(runtimeDirectory, 0700); err != nil {
		return result, errors.New("runtime directory unavailable")
	}
	defer os.RemoveAll(runtimeDirectory)
	keyDER, err := x509.MarshalPKCS8PrivateKey(snapshotKey)
	if err != nil {
		return result, errors.New("private key encoding failed")
	}
	paths := map[string][]byte{
		"client.key":    pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
		"tls-crypt.key": staticKey,
		"client.crt":    certificatePEM,
		"ca.crt":        caPEM,
	}
	for name, value := range paths {
		path := filepath.Join(runtimeDirectory, name)
		if err = os.WriteFile(path, value, 0600); err != nil {
			return result, errors.New("runtime material unavailable")
		}
		_ = os.Chmod(path, 0600)
	}
	configPath := filepath.Join(runtimeDirectory, "probe.ovpn")
	if err = os.WriteFile(configPath, []byte(renderConfig(environment, remote, port, runtimeDirectory)), 0600); err != nil {
		return result, errors.New("probe configuration unavailable")
	}
	executable := filepath.Join(os.Getenv("ProgramFiles"), "OpenVPN", "bin", "openvpn.exe")
	if info, statErr := os.Stat(executable); statErr != nil || info.IsDir() {
		return result, errors.New("managed OpenVPN executable unavailable")
	}
	output, exitCode := execute(executable, configPath, timeout)
	if logPath != "" {
		_ = os.WriteFile(logPath, []byte(output), 0600)
	}
	result.Connected = strings.Contains(output, "Initialization Sequence Completed")
	result.Revoked = strings.Contains(strings.ToLower(output), "certificate revoked")
	result.ExitCode = exitCode
	result.Lines = strings.Count(output, "\n")
	if result.Revoked {
		result.Detail = "server rejected the revoked credential"
	}
	return result, nil
}

func execute(executable, config string, timeout time.Duration) (string, int) {
	command := exec.Command(executable, "--config", config)
	type finished struct {
		output   []byte
		exitCode int
	}
	done := make(chan finished, 1)
	go func() {
		raw, err := command.CombinedOutput()
		code := 0
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			} else {
				code = -1
			}
		}
		done <- finished{output: raw, exitCode: code}
	}()
	select {
	case value := <-done:
		return string(value.output), value.exitCode
	case <-time.After(timeout):
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		value := <-done
		if value.exitCode == 0 {
			value.exitCode = 124
		}
		return string(value.output), value.exitCode
	}
}

func renderConfig(environment, remote string, port int, directory string) string {
	path := func(name string) string {
		return `"` + filepath.ToSlash(filepath.Join(directory, name)) + `"`
	}
	return strings.Join([]string{
		"client",
		"dev tun",
		"proto udp",
		fmt.Sprintf("remote %s %d", remote, port),
		"nobind",
		"resolv-retry 0",
		"connect-retry-max 1",
		"connect-timeout 8",
		"persist-key",
		"persist-tun",
		"remote-cert-tls server",
		"verify-x509-name " + environment + " name",
		"auth SHA256",
		"data-ciphers AES-256-GCM:AES-128-GCM",
		"tls-version-min 1.2",
		`pull-filter ignore "redirect-gateway"`,
		`pull-filter ignore "route-ipv6"`,
		`pull-filter ignore "ifconfig-ipv6"`,
		"ca " + path("ca.crt"),
		"cert " + path("client.crt"),
		"key " + path("client.key"),
		"tls-crypt " + path("tls-crypt.key"),
		"verb 4",
		"",
	}, "\n")
}
