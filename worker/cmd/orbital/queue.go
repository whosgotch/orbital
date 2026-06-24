package main

import (
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func queueMission(args []string, stdout io.Writer) error {
	// orbital queue <repoPath> <text> [--campaign <id>]
	if len(args) != 4 && len(args) != 6 {
		return usageError()
	}

	repoPath := args[2]
	missionText := args[3]

	campaignID := ""
	if len(args) == 6 {
		if args[4] != "--campaign" {
			return usageError()
		}
		campaignID = args[5]
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	repository, err := service.OpenRepository(repoPath)
	if err != nil {
		return err
	}

	if _, err := service.CreateMission(repository.ID, missionText, campaignID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
