//go:build windows

package clientipc

import (
	"context"
	"encoding/json"
	"os/user"
	"testing"
)

func TestNamedPipeAllowsConfiguredWindowsPrincipal(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	listener, err := Listen(`\\.\pipe\nexo-endpoint-v1`, current.Uid)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- Serve(listener, HandlerFunc(func(_ context.Context, request Request) (any, string) {
			return map[string]string{"action": request.Action}, ""
		}))
	}()
	connection, err := Dial(`\\.\pipe\nexo-endpoint-v1`)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err = connection.Write([]byte(`{"version":1,"id":"windows_01","action":"status"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	var response Response
	if err = json.NewDecoder(connection).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if !response.OK {
		t.Fatalf("unexpected response: %#v", response)
	}
	listener.Close()
	if err = <-serveDone; err != nil {
		t.Fatal(err)
	}
}
