package main

import (
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func linkMissions(args []string, stdout io.Writer) error {
	// orbital link <repoPath> <fromMissionID> <toMissionID>
	return updateLink(args, stdout, func(service *app.Service, fromID, toID string) error {
		return service.LinkMissions(fromID, toID)
	})
}

func unlinkMissions(args []string, stdout io.Writer) error {
	// orbital unlink <repoPath> <fromMissionID> <toMissionID>
	return updateLink(args, stdout, func(service *app.Service, fromID, toID string) error {
		return service.UnlinkMissions(fromID, toID)
	})
}

func updateLink(args []string, stdout io.Writer, apply func(service *app.Service, fromID, toID string) error) error {
	if len(args) != 5 {
		return usageError()
	}

	repoPath := args[2]
	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	if err := apply(service, args[3], args[4]); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
