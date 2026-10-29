package labfixture

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"time"
)

const helperPath = "/usr/local/lib/nexo/nexo-f06-lab-fixture"

var runIDPattern = regexp.MustCompile(`^f06-[a-f0-9]{12}$`)

type runner interface {
	Run(context.Context, string, ...string) error
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, arguments ...string) error {
	command := exec.CommandContext(ctx, name, arguments...)
	command.Stdout, command.Stderr = outputStreams()
	if err := command.Run(); err != nil {
		return errors.New("lab fixture helper failed")
	}
	return nil
}

func Run(action, runID string) error { return run(execRunner{}, action, runID) }

func run(command runner, action, runID string) error {
	if !isRoot() {
		return errors.New("lab fixture requires root")
	}
	if action != "prepare" && action != "cleanup" && action != "status" {
		return fmt.Errorf("unsupported lab fixture action")
	}
	if !runIDPattern.MatchString(runID) {
		return errors.New("invalid lab fixture run id")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	return command.Run(ctx, helperPath, action, runID)
}
