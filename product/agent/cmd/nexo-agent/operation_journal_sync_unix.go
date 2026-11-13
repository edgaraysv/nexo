//go:build !windows

package main

import "os"

// syncOperationJournalDirectory makes the directory entry durable after the
// journal rename. A failure is fatal for the write-ahead path: the caller must
// not execute the side effect without durable persistence.
func syncOperationJournalDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
