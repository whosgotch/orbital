package main

import (
	"context"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func verifyMission(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) != 5 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]
	verificationCommand := args[4]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	repositories, err := service.ListRepositories()
	if err != nil {
		return err
	}

	var repoID string
	for _, repository := range repositories {
		if repository.Path == repoPath {
			repoID = repository.ID
			break
		}
	}

	if repoID == "" {
		repository, err := service.OpenRepository(repoPath)
		if err != nil {
			return err
		}
		repoID = repository.ID
	}

	if _, err := service.RunVerification(ctx, repoID, missionID, verificationCommand); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
