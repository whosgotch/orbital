package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// sendAgentMessage drives one chat turn against a mission's agent, streaming the
// agent's events to stdout (the same NDJSON channel start-run uses) and printing
// the resulting state so the GUI can rehydrate.
func sendAgentMessage(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) < 5 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]
	text := args[4]

	model := ""
	effort := ""
	flags := flag.NewFlagSet("send-message", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&model, "model", "", "claude model alias or id (empty = CLI default)")
	flags.StringVar(&effort, "effort", "", "model thinking level: low/medium/high/xhigh/max (empty = CLI default)")
	if err := flags.Parse(args[5:]); err != nil || flags.NArg() != 0 {
		return usageError()
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)
	service.SetEventOut(stdout)
	service.SetRunModel(model)
	service.SetRunEffort(effort)

	service.RegisterWorker(agent.NewClaudeEngineerWorker())

	if _, err := service.SendAgentMessage(ctx, missionID, text); err != nil {
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
