package main

import (
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func editMission(args []string, stdout io.Writer) error {
	// orbital edit-mission <repoPath> <missionID> <text>
	if len(args) != 5 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]
	text := args[4]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	if _, err := service.UpdateMissionText(missionID, text); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
