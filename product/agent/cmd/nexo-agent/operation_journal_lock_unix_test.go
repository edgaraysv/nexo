//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func waitForPath(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func TestOperationJournalLockExcludesProcess(t *testing.T) {
	dir := t.TempDir()
	release, err := acquireOperationJournalLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	started := filepath.Join(dir, "child-started")
	acquired := filepath.Join(dir, "child-acquired")
	command := exec.Command(os.Args[0], "-test.run=TestOperationJournalLockHelperProcess")
	command.Env = append(os.Environ(),
		"NEXO_OPERATION_LOCK_HELPER=1",
		"NEXO_OPERATION_LOCK_DIR="+dir,
	)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err = command.Start(); err != nil {
		_ = release()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	})
	if !waitForPath(started, 5*time.Second) {
		_ = release()
		t.Fatal("helper process did not start its lock attempt")
	}
	time.Sleep(100 * time.Millisecond)
	if _, statErr := os.Stat(acquired); statErr == nil {
		_ = release()
		t.Fatal("helper process acquired the journal lock while the parent held it")
	}
	if err = release(); err != nil {
		t.Fatal(err)
	}
	if err = command.Wait(); err != nil {
		t.Fatalf("helper process failed: %v", err)
	}
	if _, statErr := os.Stat(acquired); statErr != nil {
		t.Fatal("helper process did not acquire the journal lock after release")
	}
}

// TestOperationJournalLockHelperProcess is only active in the child process
// spawned by TestOperationJournalLockExcludesProcess.
func TestOperationJournalLockHelperProcess(t *testing.T) {
	if os.Getenv("NEXO_OPERATION_LOCK_HELPER") != "1" {
		return
	}
	dir := os.Getenv("NEXO_OPERATION_LOCK_DIR")
	if dir == "" {
		t.Fatal("helper lock directory is missing")
	}
	if err := os.WriteFile(filepath.Join(dir, "child-started"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
	release, err := acquireOperationJournalLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if err = os.WriteFile(filepath.Join(dir, "child-acquired"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
}
