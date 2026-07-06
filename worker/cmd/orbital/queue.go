package main

import (
	"flag"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func queueMission(args []string, stdout io.Writer) error {
	// orbital queue <repoPath> <text> [--campaign <id>] [--tool <command>]
	if len(args) < 4 {
		return usageError()
	}

	repoPath := args[2]
	missionText := args[3]

	campaignID := ""
	toolCommand := ""
	flags := flag.NewFlagSet("queue", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&campaignID, "campaign", "", "campaign id grouping multi-repo missions")
	flags.StringVar(&toolCommand, "tool", "", "shell command making this a tool step")
	if err := flags.Parse(args[4:]); err != nil {
		return usageError()
	}
	if flags.NArg() != 0 {
		return usageError()
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	repository, err := service.OpenRepository(repoPath)
	if err != nil {
		return err
	}

	if toolCommand != "" {
		if _, err := service.CreateToolMission(repository.ID, missionText, toolCommand, campaignID); err != nil {
			return err
		}
	} else if _, err := service.CreateMission(repository.ID, missionText, campaignID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
