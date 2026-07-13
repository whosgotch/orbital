package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
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
	// Planning streams the AI's thinking as EVENT: lines while it reads the
	// repo, then the refreshed state as a final STATE: line — the same NDJSON
	// protocol runs use, so the GUI can show the planner working live.
	service.SetEventOut(stdout)
	service.SetRunModel(model)

	repository, err := service.OpenRepository(repoPath)
	if err != nil {
		return err
	}

	if _, _, err := service.PlanRepo(ctx, repository.ID, goal, domain.PlanFormat(format)); err != nil {
		return err
	}

	state, err := jsonStore.Load()
	if err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "STATE:%s\n", data)
	return err
}
