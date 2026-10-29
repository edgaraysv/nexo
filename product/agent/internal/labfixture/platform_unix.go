//go:build !windows

package labfixture

import (
	"io"
	"os"
)

func isRoot() bool                          { return os.Geteuid() == 0 }
func outputStreams() (io.Writer, io.Writer) { return os.Stdout, os.Stderr }
