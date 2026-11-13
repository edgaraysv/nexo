//go:build windows

package main

// Windows does not provide a portable directory fsync equivalent. File data is
// still synced before the atomic rename; the caller keeps the same fail-closed
// behavior for file persistence errors.
func syncOperationJournalDirectory(string) error {
	return nil
}
