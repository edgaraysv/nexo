package clientipc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"regexp"
	"time"
)

const (
	Version      = 1
	MaxFrameSize = 16 * 1024
)

var requestID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

type Request struct {
	Version int             `json:"version"`
	ID      string          `json:"id"`
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type Response struct {
	Version int    `json:"version"`
	ID      string `json:"id,omitempty"`
	OK      bool   `json:"ok"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

type Handler interface {
	Handle(context.Context, Request) (any, string)
}

type HandlerFunc func(context.Context, Request) (any, string)

func (f HandlerFunc) Handle(ctx context.Context, request Request) (any, string) {
	return f(ctx, request)
}

func Serve(listener net.Listener, handler Handler) error {
	slots := make(chan struct{}, 16)
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		select {
		case slots <- struct{}{}:
			go func() {
				defer func() { <-slots }()
				serveConnection(connection, handler)
			}()
		default:
			_ = connection.Close()
		}
	}
}

func serveConnection(connection net.Conn, handler Handler) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(io.LimitReader(connection, MaxFrameSize+1))
	frame, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		writeResponse(connection, Response{Version: Version, OK: false, Error: "invalid_frame"})
		return
	}
	if len(frame) == 0 || len(frame) > MaxFrameSize || frame[len(frame)-1] != '\n' {
		writeResponse(connection, Response{Version: Version, OK: false, Error: "invalid_frame"})
		return
	}
	var request Request
	decoderError := json.Unmarshal(frame[:len(frame)-1], &request)
	if decoderError != nil || request.Version != Version || !requestID.MatchString(request.ID) || request.Action == "" {
		writeResponse(connection, Response{Version: Version, ID: request.ID, OK: false, Error: "invalid_request"})
		return
	}
	data, code := handler.Handle(context.Background(), request)
	if code != "" {
		writeResponse(connection, Response{Version: Version, ID: request.ID, OK: false, Error: code})
		return
	}
	writeResponse(connection, Response{Version: Version, ID: request.ID, OK: true, Data: data})
}

func writeResponse(writer io.Writer, response Response) {
	encoded, err := json.Marshal(response)
	if err != nil {
		encoded = []byte(`{"version":1,"ok":false,"error":"internal_error"}`)
	}
	_, _ = writer.Write(append(encoded, '\n'))
}
