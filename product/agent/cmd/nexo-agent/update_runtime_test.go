package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestUpdateCheckInterval(t *testing.T) {
	now := time.Date(2026, time.October, 31, 12, 0, 0, 0, time.UTC)
	if updateCheckDue(now.Add(time.Minute), now) {
		t.Fatal("update check ran before its deadline")
	}
	if !updateCheckDue(now, now) || !updateCheckDue(now.Add(-time.Second), now) {
		t.Fatal("update check did not run at or after its deadline")
	}
}

func TestUpdateDownloadUsesBearerAndRejectsRedirectAndOversize(t *testing.T) {
	var leaked bool
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		leaked = true
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer device-session" {
			t.Errorf("missing update authorization header")
		}
		if request.URL.Path == "/redirect" {
			http.Redirect(writer, request, target.URL+"/collect", http.StatusFound)
			return
		}
		writer.Write([]byte("12345"))
	}))
	defer server.Close()

	status, body, err := getUpdateBytes(server.URL, "/manifest", "device-session", 5)
	if err != nil || status != http.StatusOK || string(body) != "12345" {
		t.Fatalf("bounded update fetch failed: status=%d body=%q err=%v", status, body, err)
	}
	status, _, err = getUpdateBytes(server.URL, "/redirect", "device-session", 10)
	if err != nil || status != http.StatusFound || leaked {
		t.Fatalf("redirect was followed or token leaked: status=%d err=%v leaked=%v", status, err, leaked)
	}
	if _, _, err = getUpdateBytes(server.URL, "/manifest", "device-session", 4); err == nil {
		t.Fatal("oversized update body was accepted")
	}
}
