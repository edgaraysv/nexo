//go:build !windows

package clientipc

import (
	"fmt"
	"net"
	"os"
)

func Listen(endpoint, _ string) (net.Listener, error) {
	if endpoint == "" {
		return nil, fmt.Errorf("missing unix socket path")
	}
	_ = os.Remove(endpoint)
	listener, err := net.Listen("unix", endpoint)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(endpoint, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

func Dial(endpoint string) (net.Conn, error) { return net.Dial("unix", endpoint) }
