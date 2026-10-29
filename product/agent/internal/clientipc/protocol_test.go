package clientipc

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
)

func TestProtocolAcceptsOneVersionedAllowlistedRequest(t *testing.T) {
	server, client := net.Pipe()
	done := make(chan struct{})
	go func() {
		serveConnection(server, HandlerFunc(func(_ context.Context, request Request) (any, string) {
			if request.Action != "status" {
				return nil, "unsupported_action"
			}
			return map[string]string{"state": "approved"}, ""
		}))
		close(done)
	}()
	_, _ = client.Write([]byte(`{"version":1,"id":"request_01","action":"status"}` + "\n"))
	var response Response
	if err := json.NewDecoder(client).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.ID != "request_01" {
		t.Fatalf("unexpected response: %#v", response)
	}
	client.Close()
	<-done
}

func TestProtocolRejectsMalformedOversizedAndUnknownRequests(t *testing.T) {
	tests := []struct {
		name  string
		frame string
		code  string
	}{
		{"malformed", "{\n", "invalid_request"},
		{"wrong version", `{"version":2,"id":"request_02","action":"status"}` + "\n", "invalid_request"},
		{"unknown action", `{"version":1,"id":"request_03","action":"shell"}` + "\n", "unsupported_action"},
		{"oversized", strings.Repeat("x", MaxFrameSize) + "\n", "invalid_frame"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, client := net.Pipe()
			go serveConnection(server, HandlerFunc(func(_ context.Context, _ Request) (any, string) { return nil, "unsupported_action" }))
			_, _ = client.Write([]byte(test.frame))
			line, err := bufio.NewReader(client).ReadBytes('\n')
			if err != nil {
				t.Fatal(err)
			}
			var response Response
			if err = json.Unmarshal(line, &response); err != nil {
				t.Fatal(err)
			}
			if response.Error != test.code {
				t.Fatalf("got %q, want %q", response.Error, test.code)
			}
			client.Close()
		})
	}
}
