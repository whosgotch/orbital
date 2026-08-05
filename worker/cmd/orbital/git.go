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

func writeJSON(stdout io.Writer, value any) error {
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
