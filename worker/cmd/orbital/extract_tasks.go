package main

import (
	"context"
	"flag"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// extractTasks turns a research mission's findings document into the fewest
// concrete draft missions its conclusions call for, chained after the
// research node. A blocking call — same shape as verify — since there is no
// live thinking feed to stream to the caller. Prints the refreshed state for
// the GUI to rehydrate.
func extractTasks(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) < 4 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]
	flags := flag.NewFlagSet("extract-tasks", flag.ContinueOnError)
	model := flags.String("model", "", "claude model alias or id (empty = CLI default)")
	if err := flags.Parse(args[4:]); err != nil {
		return err
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)
	service.SetRunModel(*model)

	if _, err := service.ExtractTasks(ctx, missionID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
