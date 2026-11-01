//go:build windows

package updater

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"nexo.local/agent/internal/clientipc"
)

const endpointServiceName = "NexoEndpoint"

func RunApply(stateDir string, now time.Time) error {
	if err := validateSystemStateDir(stateDir); err != nil {
		return err
	}
	keyring, err := EmbeddedTrustKeyring()
	if err != nil || len(keyring) == 0 {
		return errors.New("update trust configuration unavailable")
	}
	statePath := filepath.Join(stateDir, "update-security-state.bin")
	state, err := LoadSecurityState(statePath)
	if err != nil {
		return errors.New("update security state unavailable")
	}
	stagingDir := filepath.Join(stateDir, "updates")
	manifest, pending, err := ValidateStagedSecureRelease(stagingDir, state, keyring, now)
	if err != nil {
		return err
	}
	active, err := os.Executable()
	if err != nil {
		return err
	}
	installDir := filepath.Dir(active)
	active = filepath.Join(installDir, "nexo-agent.exe")
	rollback := filepath.Join(installDir, "nexo-agent.rollback.exe")
	packagePath := filepath.Join(stagingDir, pending.Package)
	if info, statErr := os.Lstat(active); statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("active agent unavailable")
	}
	candidateAlreadyActive, err := fileMatches(active, manifest.SHA256, manifest.Size)
	if err != nil {
		return err
	}
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(endpointServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	if err = stopService(service, 45*time.Second); err != nil {
		return err
	}
	if !candidateAlreadyActive {
		if err = copyFileRestricted(active, rollback); err != nil {
			_ = startService(service)
			return err
		}
		if err = replaceFile(packagePath, active, manifest.SHA256, manifest.Size); err != nil {
			_ = restoreRollback(rollback, active)
			_ = startService(service)
			return err
		}
	}
	if err = startService(service); err == nil {
		err = waitHealthy(service, `\\.\pipe\nexo-endpoint-v1`, manifest.Version, 45*time.Second)
	}
	if err != nil {
		_ = stopService(service, 30*time.Second)
		if !pending.RollbackAllowed {
			return fmt.Errorf("updated service failed health check; previous version is blocked: %w", err)
		}
		if restoreErr := restoreRollback(rollback, active); restoreErr != nil {
			return fmt.Errorf("update health check and rollback failed: %w", errors.Join(err, restoreErr))
		}
		if startErr := startService(service); startErr != nil {
			return fmt.Errorf("update failed and previous service could not restart: %w", errors.Join(err, startErr))
		}
		return fmt.Errorf("update health check failed; previous permitted agent restored: %w", err)
	}
	advanced, err := AdvanceSecurityState(state, manifest)
	if err != nil {
		return rollbackAfterCommitFailure(service, rollback, active, pending.RollbackAllowed, err)
	}
	if err = SaveSecurityState(statePath, advanced); err != nil {
		return rollbackAfterCommitFailure(service, rollback, active, pending.RollbackAllowed, errors.New("failed to persist update security state"))
	}
	_ = os.Remove(rollback)
	_ = os.Remove(packagePath)
	_ = os.Remove(filepath.Join(stagingDir, "nexo-agent.pending.json"))
	_ = os.Remove(filepath.Join(stagingDir, "update-state.json"))
	return nil
}

func rollbackAfterCommitFailure(service *mgr.Service, rollback, active string, rollbackAllowed bool, cause error) error {
	if err := stopService(service, 30*time.Second); err != nil {
		return errors.Join(cause, fmt.Errorf("failed to stop candidate before rollback: %w", err))
	}
	if !rollbackAllowed {
		return fmt.Errorf("candidate could not be committed and prior version is blocked: %w", cause)
	}
	if err := restoreRollback(rollback, active); err != nil {
		return errors.Join(cause, fmt.Errorf("failed to restore previous agent: %w", err))
	}
	if err := startService(service); err != nil {
		return errors.Join(cause, fmt.Errorf("failed to restart previous agent: %w", err))
	}
	return cause
}

func validateSystemStateDir(path string) error {
	programData := os.Getenv("ProgramData")
	if programData == "" || path == "" {
		return errors.New("system update state path unavailable")
	}
	want := filepath.Clean(filepath.Join(programData, "NEXO", "Endpoint"))
	got := filepath.Clean(path)
	if !strings.EqualFold(want, got) {
		return errors.New("system update state path rejected")
	}
	return nil
}

func stopService(service *mgr.Service, timeout time.Duration) error {
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Stopped {
		return nil
	}
	if status.State != svc.StopPending {
		if _, err = service.Control(svc.Stop); err != nil {
			return err
		}
	}
	return waitServiceState(service, svc.Stopped, timeout)
}

func startService(service *mgr.Service) error {
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Running {
		return nil
	}
	if status.State != svc.StartPending {
		if err = service.Start(); err != nil {
			return err
		}
	}
	return waitServiceState(service, svc.Running, 45*time.Second)
}

func waitServiceState(service *mgr.Service, expected svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == expected {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("service did not reach state %d", expected)
}

func waitHealthy(service *mgr.Service, endpoint, expectedVersion string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err == nil && status.State == svc.Running {
			if probeEndpoint(endpoint, expectedVersion) == nil {
				return nil
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return errors.New("updated endpoint did not pass SCM and IPC health checks")
}

func probeEndpoint(endpoint, expectedVersion string) error {
	connection, err := clientipc.Dial(endpoint)
	if err != nil {
		return err
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
	request := clientipc.Request{Version: clientipc.Version, ID: "update_health_01", Action: "health"}
	encoded, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if _, err = connection.Write(append(encoded, '\n')); err != nil {
		return err
	}
	line, err := bufio.NewReader(io.LimitReader(connection, clientipc.MaxFrameSize+1)).ReadBytes('\n')
	if err != nil || len(line) > clientipc.MaxFrameSize {
		return errors.New("invalid endpoint health response")
	}
	var response struct {
		ID   string `json:"id"`
		OK   bool   `json:"ok"`
		Data struct {
			Service      string `json:"service"`
			AgentVersion string `json:"agent_version"`
		} `json:"data"`
	}
	if err = json.Unmarshal(bytes.TrimSpace(line), &response); err != nil || response.ID != request.ID || !response.OK || response.Data.Service != "running" || response.Data.AgentVersion != expectedVersion {
		return errors.New("endpoint health check rejected")
	}
	return nil
}

func copyFileRestricted(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	return errors.Join(copyErr, syncErr, closeErr)
}

func fileMatches(path, expectedSHA256 string, expectedSize int64) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != expectedSize {
		return false, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	digest := sha256.New()
	written, err := io.Copy(digest, io.LimitReader(file, expectedSize+1))
	if err != nil {
		return false, err
	}
	return written == expectedSize && hex.EncodeToString(digest.Sum(nil)) == expectedSHA256, nil
}

func replaceFile(source, destination, expectedSHA256 string, expectedSize int64) error {
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != expectedSize {
		return errors.New("candidate agent file is invalid")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".nexo-agent-update-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temporary, digest), input)
	if copyErr == nil && (written != expectedSize || hex.EncodeToString(digest.Sum(nil)) != expectedSHA256) {
		copyErr = errors.New("candidate agent hash mismatch")
	}
	if copyErr == nil {
		copyErr = temporary.Sync()
	}
	if closeErr := temporary.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return copyErr
	}
	from, err := windows.UTF16PtrFromString(temporaryPath)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}

func restoreRollback(rollback, active string) error {
	info, err := os.Lstat(rollback)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("rollback agent file unavailable")
	}
	from, err := windows.UTF16PtrFromString(rollback)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(active)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
