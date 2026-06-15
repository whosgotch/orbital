package main

import (
	"context"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func startAgentRun(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) != 4 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	if _, err := service.StartAgentRun(ctx, missionID, "mock"); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
