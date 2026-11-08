package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRotateNodeCredentialProvesPersistentKeyAndSavesCertificate(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	const nodeID = "55555555-5555-4555-8555-555555555555"
	const rotationID = "66666666-6666-4666-8666-666666666666"
	if err = writeState(dir, state{DeviceID: nodeID, Audience: "node", Serial: "old-serial", CertificatePEM: "expired-certificate"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/node-credential-rotations/"+rotationID+"/complete" {
			t.Errorf("unexpected rotation request: %s %s", request.Method, request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			NodeID    string `json:"node_id"`
			Signature string `json:"signature"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("invalid request body: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.NodeID != nodeID {
			t.Errorf("node id = %q, want %q", body.NodeID, nodeID)
		}
		signature, err := base64.StdEncoding.DecodeString(body.Signature)
		if err != nil {
			t.Errorf("invalid signature encoding: %v", err)
		}
		digest := sha256.Sum256([]byte("nexo-node-credential-rotation-v1\n" + nodeID + "\n" + rotationID))
		if !ecdsa.VerifyASN1(&key.PublicKey, digest[:], signature) {
			t.Error("rotation proof did not verify with the persistent node key")
		}
		writer.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]string{
			"serial": "new-serial", "certificate_pem": "new-certificate",
			"not_before": "2026-11-08T00:00:00Z", "not_after": "2026-12-08T00:00:00Z",
		})
	}))
	defer server.Close()

	var output bytes.Buffer
	if err = rotateNodeCredential(server.URL, dir, key, rotationID, &output); err != nil {
		t.Fatal(err)
	}
	updated, err := readState(dir)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Serial != "new-serial" || updated.CertificatePEM != "new-certificate" || updated.DeviceID != nodeID {
		t.Fatalf("state was not updated with the rotated certificate: %#v", updated)
	}
	if output.Len() == 0 {
		t.Fatal("rotation status was not written")
	}
	if _, err = os.Stat(filepath.Join(dir, "state.json")); err != nil {
		t.Fatal(err)
	}
}

func TestRotateNodeCredentialRejectsNonNodeIdentity(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err = writeState(dir, state{DeviceID: "55555555-5555-4555-8555-555555555555", Audience: "endpoint"}); err != nil {
		t.Fatal(err)
	}
	err = rotateNodeCredential("http://127.0.0.1", dir, key, "66666666-6666-4666-8666-666666666666", &bytes.Buffer{})
	if err == nil {
		t.Fatal("endpoint identity should not rotate a node credential")
	}
}
