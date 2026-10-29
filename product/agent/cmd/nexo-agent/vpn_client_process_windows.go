//go:build windows

package main

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsVPNLauncher struct{ executable string }
type windowsVPNProcess struct {
	process *os.Process
	job     windows.Handle
	once    sync.Once
}

func newPlatformVPNLauncher() (vpnLauncher, error) {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		return nil, errors.New("ProgramFiles unavailable")
	}
	executable := filepath.Join(programFiles, "OpenVPN", "bin", "openvpn.exe")
	if info, err := os.Stat(executable); err != nil || info.IsDir() {
		return nil, errors.New("managed OpenVPN executable unavailable")
	}
	return &windowsVPNLauncher{executable: executable}, nil
}

func (launcher *windowsVPNLauncher) Start(configPath string, onLine func(string), onExit func(error)) (vpnProcess, error) {
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

func (process *windowsVPNProcess) Stop() error {
	process.close()
	return nil
}

func (process *windowsVPNProcess) close() {
	process.once.Do(func() { _ = windows.CloseHandle(process.job); _ = process.process.Kill() })
}
