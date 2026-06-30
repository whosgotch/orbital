package main

import (
	"context"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func planMission(ctx context.Context, args []string, stdout io.Writer) error {
	// orbital plan <repoPath> <missionID>
	if len(args) != 4 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	if _, err := service.PlanMission(ctx, missionID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
