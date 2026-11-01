//go:build windows

package main

import (
	"fmt"
	"os"
	"time"

	"nexo.local/agent/internal/updater"
)

func main() {
	if len(os.Args) != 3 || os.Args[1] != "--apply" {
		fmt.Fprintln(os.Stderr, "usage: nexo-agent-updater --apply <ProgramData state directory>")
		os.Exit(2)
	}
	if err := updater.RunApply(os.Args[2], time.Now()); err != nil {
		fmt.Fprintln(os.Stderr, "nexo_agent_update_failed")
		os.Exit(1)
	}
}
