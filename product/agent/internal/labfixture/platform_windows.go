//go:build windows

package labfixture

import (
	"io"
	"os"
)

func isRoot() bool                          { return false }
func outputStreams() (io.Writer, io.Writer) { return os.Stdout, os.Stderr }
