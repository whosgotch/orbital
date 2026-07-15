package main

import (
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func approvePlan(args []string, stdout io.Writer) error {
	// orbital approve-plan <repoPath> <planID>
	if len(args) != 4 {
		return usageError()
	}

	repoPath := args[2]
	planID := args[3]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	if _, _, err := service.ApprovePlan(planID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}

func deletePlan(args []string, stdout io.Writer) error {
	// orbital delete-plan <repoPath> <planID>
	if len(args) != 4 {
		return usageError()
	}

	repoPath := args[2]
	planID := args[3]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	if err := service.DeletePlan(planID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
