package main

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"nexo.local/agent/internal/updater"
)

var agentVersion = "0.1.0"

const (
	updateManifestPath = "/v1/device/agent-updates/current"
	updateInterval     = 6 * time.Hour
	initialUpdateDelay = 2 * time.Minute
)

func updateCheckDue(nextCheck, now time.Time) bool {
	return !now.Before(nextCheck)
}

func getUpdateBytes(base, path, token string, maxBytes int64) (int, []byte, error) {
	request, err := http.NewRequest(http.MethodGet, base+path, nil)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("accept", "application/octet-stream, application/json")
	request.Header.Set("authorization", "Bearer "+token)
	client := http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return response.StatusCode, nil, nil
	}
	if response.ContentLength > maxBytes {
		return response.StatusCode, nil, errors.New("update response exceeds size limit")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return response.StatusCode, nil, err
	}
	if int64(len(body)) > maxBytes {
		return response.StatusCode, nil, errors.New("update response exceeds size limit")
	}
	return response.StatusCode, body, nil
}

func updateKeyring() (map[string]ed25519.PublicKey, error) {
	return updater.EmbeddedTrustKeyring()
}

func (service *serviceRuntime) checkAndStartAgentUpdate() error {
	if runtime.GOOS != "windows" {
		service.setUpdateStatus("windows_only")
		return nil
	}
	keyring, err := updateKeyring()
	if err != nil {
		service.setUpdateStatus("trust_configuration_invalid")
		return err
	}
	if len(keyring) == 0 {
		service.setUpdateStatus("disabled_unconfigured")
		return nil
	}
	statePath := filepath.Join(service.dir, "update-security-state.bin")
	securityState, err := updater.LoadSecurityStateForRuntime(statePath, agentVersion)
	if err != nil {
		service.setUpdateStatus("security_state_unavailable")
		return err
	}
	if securityState.InstalledVersion != agentVersion {
		executable, executableErr := os.Executable()
		if executableErr != nil || updater.ValidateStagedExecutable(filepath.Join(service.dir, "updates"), executable, agentVersion, securityState, keyring, time.Now()) != nil {
			service.setUpdateStatus("update_recovery_unavailable")
			return errors.New("pending signed update recovery unavailable")
		}
		return service.launchAgentUpdater(agentVersion)
	}
	device, session, err := authenticateSession(service.base, service.dir, service.key)
	if err != nil || device.Audience != "endpoint" || device.Serial == "" {
		service.setUpdateStatus("device_authentication_unavailable")
		return errors.New("update authentication unavailable")
	}
	token, ok := session["token"].(string)
	if !ok || token == "" {
		service.setUpdateStatus("device_authentication_unavailable")
		return errors.New("update authentication unavailable")
	}
	status, manifestBytes, err := getUpdateBytes(service.base, updateManifestPath, token, updater.MaxManifestSize)
	if err != nil {
		service.setUpdateStatus("manifest_download_failed")
		return err
	}
	if status == http.StatusNoContent || status == http.StatusNotFound {
		service.setUpdateStatus("no_release")
		return nil
	}
	if status != http.StatusOK {
		service.setUpdateStatus("manifest_unavailable")
		return fmt.Errorf("update manifest returned %d", status)
	}
	manifest, err := updater.VerifySecureManifest(manifestBytes, agentVersion, runtime.GOOS, runtime.GOARCH, securityState, keyring, time.Now())
	if errors.Is(err, updater.ErrNoUpdate) {
		executable, executableErr := os.Executable()
		if executableErr != nil || updater.VerifyAgentFile(executable, manifest.SHA256, manifest.Size) != nil {
			service.setUpdateStatus("installed_release_hash_mismatch")
			return errors.New("installed agent does not match signed release metadata")
		}
		if manifest.MetadataVersion > securityState.MetadataVersion {
			advanced, advanceErr := updater.AdvanceMetadataState(securityState, manifest)
			if advanceErr == nil {
				advanceErr = updater.SaveSecurityState(statePath, advanced)
			}
			if advanceErr != nil {
				service.setUpdateStatus("metadata_state_unavailable")
				return advanceErr
			}
		}
		service.setUpdateStatus("current")
		return nil
	}
	if err != nil {
		service.setUpdateStatus("manifest_rejected")
		return err
	}
	packagePath := "/v1/device/agent-updates/" + manifest.Version + "/package"
	status, packageBytes, err := getUpdateBytes(service.base, packagePath, token, updater.MaxPackageSize)
	if err != nil {
		service.setUpdateStatus("package_download_failed")
		return err
	}
	if status != http.StatusOK {
		service.setUpdateStatus("package_unavailable")
		return fmt.Errorf("update package returned %d", status)
	}
	stagingDir := filepath.Join(service.dir, "updates")
	_, _, err = updater.StageSecureRelease(manifestBytes, bytes.NewReader(packageBytes), stagingDir, agentVersion, runtime.GOOS, runtime.GOARCH, securityState, keyring, time.Now())
	if err != nil {
		service.setUpdateStatus("staging_failed")
		return err
	}
	return service.launchAgentUpdater(manifest.Version)
}

func (service *serviceRuntime) launchAgentUpdater(version string) error {
	executable, err := os.Executable()
	if err != nil {
		service.setUpdateStatus("updater_helper_unavailable")
		return err
	}
	helper := filepath.Join(filepath.Dir(executable), "nexo-agent-updater.exe")
	if info, statErr := os.Stat(helper); statErr != nil || !info.Mode().IsRegular() {
		service.setUpdateStatus("updater_helper_unavailable")
		return errors.New("update helper unavailable")
	}
	service.setUpdateStatus("applying_" + version)
	command := exec.Command(helper, "--apply", service.dir)
	command.Dir = filepath.Dir(executable)
	if err = command.Start(); err != nil {
		service.setUpdateStatus("updater_helper_start_failed")
		return err
	}
	_ = command.Process.Release()
	return nil
}
