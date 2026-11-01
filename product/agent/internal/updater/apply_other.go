//go:build !windows

package updater

import (
	"errors"
	"time"
)

func RunApply(_ string, _ time.Time) error { return errors.New("update application is Windows-only") }
