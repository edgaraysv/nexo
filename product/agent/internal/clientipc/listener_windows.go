//go:build windows

package clientipc

import (
	"fmt"
	"net"
	"regexp"
	"time"

	"github.com/Microsoft/go-winio"
)

var sidPattern = regexp.MustCompile(`^S-1-[0-9]+(?:-[0-9]+)+$`)

func Listen(endpoint, allowedSID string) (net.Listener, error) {
	if endpoint != `\\.\pipe\nexo-endpoint-v1` {
		return nil, fmt.Errorf("unsupported pipe endpoint")
	}
	if !sidPattern.MatchString(allowedSID) {
		return nil, fmt.Errorf("invalid allowed SID")
	}
	return winio.ListenPipe(endpoint, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;GRGW;;;" + allowedSID + ")",
		MessageMode:        false,
		InputBufferSize:    MaxFrameSize,
		OutputBufferSize:   MaxFrameSize,
	})
}

func Dial(endpoint string) (net.Conn, error) {
	return winio.DialPipe(endpoint, ptrDuration(5*time.Second))
}

func ptrDuration(value time.Duration) *time.Duration { return &value }
