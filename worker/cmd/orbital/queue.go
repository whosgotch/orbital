package main

import (
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func queueMission(args []string, stdout io.Writer) error {
	if len(args) != 4 {
		return usageError()
	}

	repoPath := args[2]
	missionText := args[3]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	repository, err := service.OpenRepository(repoPath)
	if err != nil {
		return err
	}

	if _, err := service.CreateMission(repository.ID, missionText); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
