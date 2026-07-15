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

func startAgentRun(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) < 4 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]
	options, err := parseStartRunOptions(args[4:])
	if err != nil {
		return err
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := serviceForStartRun(jsonStore, options)
	service.SetEventOut(stdout)
	service.SetRunModel(options.model)

	service.RegisterWorker(agent.NewClaudeEngineerWorker())
	service.RegisterWorker(agent.NewClaudeResearcherWorker())
	for _, worker := range testWorkers {
		service.RegisterWorker(worker)
	}

	if _, err := service.StartAgentRun(ctx, missionID, options.workerName); err != nil {
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

// testWorkers lets tests register additional workers (e.g. a mock that
// produces a deterministic patch) without shipping those doubles in the binary.
// It is empty in production builds.
var testWorkers []agent.Worker

type startRunOptions struct {
	workerName string
	command    string
	model      string
}

func parseStartRunOptions(args []string) (startRunOptions, error) {
	options := startRunOptions{workerName: "claude-engineer"}
	flags := flag.NewFlagSet("start-run", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&options.workerName, "worker", options.workerName, "worker name")
	flags.StringVar(&options.command, "command", "", "local command worker command")
	flags.StringVar(&options.model, "model", "", "claude model alias or id (empty = CLI default)")

	if err := flags.Parse(args); err != nil {
		return options, usageError()
	}
	if flags.NArg() != 0 {
		return options, usageError()
	}

	return options, nil
}

func serviceForStartRun(jsonStore *store.JSONStore, options startRunOptions) *app.Service {
	if options.workerName != "local-command" {
		return app.NewService(jsonStore)
	}

	registry := agent.NewWorkerRegistry()
	registry.Register(agent.NewLocalCommandWorker(options.command))
	return app.NewServiceWithWorkerRegistry(jsonStore, registry)
}
