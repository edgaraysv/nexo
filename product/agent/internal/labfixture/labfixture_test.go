package labfixture

import (
	"context"
	"testing"
)

type recordingRunner struct {
	name      string
	arguments []string
}

func (runner *recordingRunner) Run(_ context.Context, name string, arguments ...string) error {
	runner.name, runner.arguments = name, append([]string(nil), arguments...)
	return nil
}

func TestRunAcceptsOnlyTypedActionsAndRunIDs(t *testing.T) {
	if !isRoot() {
		t.Skip("root-only command contract")
	}
	runner := &recordingRunner{}
	if err := run(runner, "prepare", "f06-012345abcdef"); err != nil {
		t.Fatal(err)
	}
	if runner.name != helperPath || len(runner.arguments) != 2 || runner.arguments[0] != "prepare" || runner.arguments[1] != "f06-012345abcdef" {
		t.Fatalf("unexpected command: %#v", runner)
	}
	for _, invalid := range [][2]string{{"run", "f06-012345abcdef"}, {"prepare", "../../tmp"}, {"cleanup", "f06-ABCDEF012345"}} {
		if err := run(runner, invalid[0], invalid[1]); err == nil {
			t.Fatalf("accepted %#v", invalid)
		}
	}
}
