//go:build !windows

package updater

import "os"

func replaceAtomicFile(source, destination string) error {
	return os.Rename(source, destination)
}
