//go:build windows

package main

import (
	"crypto/ecdsa"
	"fmt"

	"golang.org/x/sys/windows/svc"
)

const windowsServiceName = "NexoEndpoint"

type windowsService struct {
	base       string
	dir        string
	allowedSID string
	key        *ecdsa.PrivateKey
}

func runWindowsService(base, dir, allowedSID string, key *ecdsa.PrivateKey) error {
	isService, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	if !isService {
		return fmt.Errorf("windows-service must be started by the service control manager")
	}
	return svc.Run(windowsServiceName, &windowsService{base: base, dir: dir, allowedSID: allowedSID, key: key})
}

func (service *windowsService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runServiceUntil(service.base, service.dir, `\\.\pipe\nexo-endpoint-v1`, service.allowedSID, service.key, stop)
	}()
	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	for {
		select {
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				close(stop)
				if err := <-done; err != nil {
					return true, 1
				}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		}
	}
}
