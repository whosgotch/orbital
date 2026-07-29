package main

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func showStatus(args []string, stdout io.Writer) error {
	if len(args) == 4 && args[2] == "--json" {
		return showStatusJSON(args[3], stdout)
	}
	if len(args) != 3 {
		return usageError()
	}

	repoPath := args[2]
	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	repositories, err := service.ListRepositories()
	if err != nil {
		return err
	}

	for _, repository := range repositories {
		_, _ = fmt.Fprintf(stdout, "repository: %s (%s)\n", repository.ID, repository.Path)

		missions, err := service.ListMissionsByRepository(repository.ID)
		if err != nil {
			return err
		}

		for _, mission := range missions {
			if err := printMissionStatus(stdout, service, mission); err != nil {
				return err
			}
		}
	}

	return nil
}

func showStatusJSON(repoPath string, stdout io.Writer) error {
	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	state, err := service.LoadStateWithLiveBranches()
	if err != nil {
		return err
	}

	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(state)
}

func printMissionStatus(stdout io.Writer, service *app.Service, mission domain.Mission) error {
	_, _ = fmt.Fprintf(stdout, "mission: %s (%s)\n", mission.ID, mission.Status)

	runs, err := service.ListRunsByMission(mission.ID)
	if err != nil {
		return err
	}
	for _, run := range runs {
		_, _ = fmt.Fprintf(stdout, "  run: %s (%s)\n", run.ID, run.Status)

		patches, err := service.ListPatchesByRun(run.ID)
		if err != nil {
			return err
		}
		for _, patch := range patches {
			_, _ = fmt.Fprintf(stdout, "    patch: %s (%s)\n", patch.ID, patch.Status)
		}
	}

	events, err := service.ListEventsByMission(mission.ID)
	if err != nil {
		return err
	}
	printTimeline(stdout, events)

	return nil
}
