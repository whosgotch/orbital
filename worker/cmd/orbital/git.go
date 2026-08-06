package main

import (
	"encoding/json"
	"io"

	"github.com/whosgotch/orbital/worker/internal/app"
)

func showGitSync(args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return usageError()
	}

	return writeJSON(stdout, app.GitSyncState(args[2]))
}

func pushRepository(args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return usageError()
	}

	sync, err := app.PushRepo(args[2])
	if err != nil {
		return err
	}

	return writeJSON(stdout, sync)
}

func listBranches(args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return usageError()
	}

	return writeJSON(stdout, app.ListBranches(args[2]))
}

// switch-branch <repo-path> <branch> [--create]: --create is the picker's
// "create <name>" path, where the typed name matched no existing branch.
func switchBranch(args []string, stdout io.Writer) error {
	if len(args) != 4 && len(args) != 5 {
		return usageError()
	}
	create := false
	if len(args) == 5 {
		if args[4] != "--create" {
			return usageError()
		}
		create = true
	}

	sync, err := app.SwitchBranch(args[2], args[3], create)
	if err != nil {
		return err
	}

	return writeJSON(stdout, sync)
}

func writeJSON(stdout io.Writer, value any) error {
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
