//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

// acquireOperationJournalLock takes an OS advisory lock covering the whole
// journal read/marker/execute/final sequence. The lock is released on process
// exit by the kernel even after a crash, so it does not create a stale lock
// that would permanently block recovery.
func acquireOperationJournalLock(dir string) (func() error, error) {
	path := filepath.Join(dir, "operation-journal.lock")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		file.Close()
		return nil, err
	}
	return func() error {
		unlockErr := syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		closeErr := file.Close()
		if unlockErr != nil {
			return unlockErr
		}
		return closeErr
	}, nil
}
