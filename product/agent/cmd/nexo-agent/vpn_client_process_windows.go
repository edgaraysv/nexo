//go:build windows

package main

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"nexo.local/agent/internal/vpnruntime"
)

type windowsVPNLauncher struct {
	executable          string
	wireguardExecutable string
}
type windowsVPNProcess struct {
	process *os.Process
	job     windows.Handle
	once    sync.Once
}

type windowsWireGuardProcess struct {
	executable string
	tunnelName string
	mu         sync.Mutex
	stopped    bool
}

var managedWireGuardTunnelName = regexp.MustCompile(`^nexo-[a-f0-9]{32}$`)

func newPlatformVPNLauncher() (vpnLauncher, error) {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		return nil, errors.New("ProgramFiles unavailable")
	}
	openvpn := filepath.Join(programFiles, "OpenVPN", "bin", "openvpn.exe")
	if info, err := os.Stat(openvpn); err != nil || info.IsDir() {
		openvpn = ""
	}
	wireguard := filepath.Join(programFiles, "WireGuard", "wireguard.exe")
	if info, err := os.Stat(wireguard); err != nil || info.IsDir() {
		wireguard = ""
	}
	if openvpn == "" && wireguard == "" {
		return nil, errors.New("managed vpn executable unavailable")
	}
	return &windowsVPNLauncher{executable: openvpn, wireguardExecutable: wireguard}, nil
}

func (launcher *windowsVPNLauncher) Start(configPath string, onLine func(string), onExit func(error)) (vpnProcess, error) {
	if strings.EqualFold(filepath.Ext(configPath), ".conf") {
		if launcher.wireguardExecutable == "" || !filepath.IsAbs(configPath) {
			return nil, errors.New("managed WireGuard executable unavailable")
		}
		tunnelName := strings.TrimSuffix(filepath.Base(configPath), filepath.Ext(configPath))
		if !managedWireGuardTunnelName.MatchString(tunnelName) {
			return nil, errors.New("invalid managed WireGuard tunnel name")
		}
		if err := stopWireGuardTunnel(launcher.wireguardExecutable, tunnelName); err != nil {
			return nil, errors.New("stale WireGuard tunnel service could not be removed")
		}
		command := exec.Command(launcher.wireguardExecutable, "/installtunnelservice", configPath)
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		command.Stdout, command.Stderr = io.Discard, io.Discard
		if err := command.Run(); err != nil {
			return nil, errors.New("managed WireGuard tunnel service failed")
		}
		return &windowsWireGuardProcess{executable: launcher.wireguardExecutable, tunnelName: tunnelName}, nil
	}
	if launcher.executable == "" {
		return nil, errors.New("managed OpenVPN executable unavailable")
	}
	reader, writer := io.Pipe()
	command := exec.Command(launcher.executable, "--config", configPath)
	command.Stdout, command.Stderr = writer, writer
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := command.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		_ = command.Process.Kill()
		return nil, err
	}
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	information.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&information)), uint32(unsafe.Sizeof(information))); err != nil {
		_ = windows.CloseHandle(job)
		_ = command.Process.Kill()
		return nil, err
	}
	processHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(command.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		_ = command.Process.Kill()
		return nil, err
	}
	err = windows.AssignProcessToJobObject(job, processHandle)
	_ = windows.CloseHandle(processHandle)
	if err != nil {
		_ = windows.CloseHandle(job)
		_ = command.Process.Kill()
		return nil, err
	}
	process := &windowsVPNProcess{process: command.Process, job: job}
	go func() {
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			onLine(scanner.Text())
		}
	}()
	go func() {
		err := command.Wait()
		process.close()
		_ = writer.Close()
		_ = reader.Close()
		onExit(err)
	}()
	return process, nil
}

func (launcher *windowsVPNLauncher) StopEnvironment(environmentID string) error {
	if !vpnruntime.ValidEnvironmentID(environmentID) {
		return errors.New("invalid managed WireGuard environment")
	}
	if launcher.wireguardExecutable == "" {
		return stopWireGuardTunnel("", "nexo-"+strings.ReplaceAll(environmentID, "-", ""))
	}
	return stopWireGuardTunnel(launcher.wireguardExecutable, "nexo-"+strings.ReplaceAll(environmentID, "-", ""))
}

func (process *windowsVPNProcess) Stop() error {
	process.close()
	return nil
}

func (process *windowsVPNProcess) close() {
	process.once.Do(func() { _ = windows.CloseHandle(process.job); _ = process.process.Kill() })
}

func (process *windowsWireGuardProcess) Stop() error {
	process.mu.Lock()
	defer process.mu.Unlock()
	if process.stopped {
		return nil
	}
	if err := stopWireGuardTunnel(process.executable, process.tunnelName); err != nil {
		return errors.New("managed WireGuard tunnel service could not be removed")
	}
	process.stopped = true
	return nil
}

func stopWireGuardTunnel(executable, tunnelName string) error {
	serviceName, err := windows.UTF16PtrFromString("WireGuardTunnel$" + tunnelName)
	if err != nil {
		return errors.New("invalid WireGuard tunnel service name")
	}
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return errors.New("Windows service manager unavailable")
	}
	defer windows.CloseServiceHandle(manager)
	service, err := windows.OpenService(manager, serviceName, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil
		}
		return errors.New("WireGuard tunnel service state unavailable")
	}
	_ = windows.CloseServiceHandle(service)
	if executable == "" {
		return errors.New("managed WireGuard executable unavailable")
	}
	command := exec.Command(executable, "/uninstalltunnelservice", tunnelName)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err = command.Run(); err != nil {
		return errors.New("WireGuard tunnel service uninstall failed")
	}
	return nil
}
