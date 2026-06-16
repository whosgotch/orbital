package main

import (
	"context"
	"flag"
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

	if _, err := service.StartAgentRun(ctx, missionID, options.workerName); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}

type startRunOptions struct {
	workerName string
	command    string
}

func parseStartRunOptions(args []string) (startRunOptions, error) {
	options := startRunOptions{workerName: "mock"}
	flags := flag.NewFlagSet("start-run", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&options.workerName, "worker", options.workerName, "worker name")
	flags.StringVar(&options.command, "command", "", "local command worker command")

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

	registry := agent.NewDefaultWorkerRegistry()
	registry.Register(agent.NewLocalCommandWorker(options.command))
	return app.NewServiceWithWorkerRegistry(jsonStore, registry)
}
