package main

import (
	"context"
	"flag"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// decomposeMission asks the AI to break a draft task into sub-tasks, replacing
// the node with them when it splits (and leaving it untouched when the task is
// one coherent change), then prints the refreshed state for the GUI to rehydrate.
func decomposeMission(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) < 4 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]

	model := ""
	flags := flag.NewFlagSet("decompose", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&model, "model", "", "claude model alias or id (empty = CLI default)")
	if err := flags.Parse(args[4:]); err != nil || flags.NArg() != 0 {
		return usageError()
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)
	service.SetRunModel(model)

	if _, err := service.DecomposeMission(ctx, missionID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
