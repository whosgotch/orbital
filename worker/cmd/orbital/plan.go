package main

import (
	"context"
	"flag"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// planRepo runs a repo-level planning pass: the AI reads the repo, writes a plan
// for the goal in the chosen format, and fans out the task nodes to carry it
// out. Prints the refreshed state for the GUI to rehydrate.
func planRepo(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) < 3 {
		return usageError()
	}

	repoPath := args[2]

	goal := ""
	if len(args) > 3 {
		goal = args[3]
	}

	model := ""
	format := ""
	flags := flag.NewFlagSet("plan", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&model, "model", "", "claude model alias or id (empty = CLI default)")
	flags.StringVar(&format, "format", "md", "plan format: md | html | text")
	start := 4
	if len(args) <= 3 {
		start = 3
	}
	if err := flags.Parse(args[start:]); err != nil || flags.NArg() != 0 {
		return usageError()
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)
	service.SetRunModel(model)

	repository, err := service.OpenRepository(repoPath)
	if err != nil {
		return err
	}

	if _, _, err := service.PlanRepo(ctx, repository.ID, goal, domain.PlanFormat(format)); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
