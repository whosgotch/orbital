package main

import (
	"fmt"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func approveMissionPatch(args []string, stdout io.Writer) error {
	if len(args) != 4 && len(args) != 5 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]
	// The commit message the user edited in the gate; absent means "use the
	// engineer's suggested subject", which is what the box was pre-filled with.
	message := ""
	if len(args) == 5 {
		message = args[4]
	}

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	patch, err := latestPatchForMission(service, missionID)
	if err != nil {
		return err
	}

	switch patch.Status {
	case domain.PatchStatusPending:
		if _, err := service.ApprovePatch(patch.ID); err != nil {
			return err
		}
		if _, err := service.ApplyPatch(patch.ID, message); err != nil {
			return err
		}
	case domain.PatchStatusApproved:
		if _, err := service.ApplyPatch(patch.ID, message); err != nil {
			return err
		}
	case domain.PatchStatusApplied:
		return showStatusJSON(repoPath, stdout)
	default:
		return fmt.Errorf("patch proposal cannot be approved from status %q: %s", patch.Status, patch.ID)
	}

	return showStatusJSON(repoPath, stdout)
}

func rejectMissionPatch(args []string, stdout io.Writer) error {
	if len(args) != 4 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	patch, err := latestPatchForMission(service, missionID)
	if err != nil {
		return err
	}

	if _, err := service.RejectPatch(patch.ID); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}

func amendMissionCommit(args []string, stdout io.Writer) error {
	if len(args) != 5 {
		return usageError()
	}

	repoPath := args[2]
	missionID := args[3]
	message := args[4]

	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	patch, err := latestPatchForMission(service, missionID)
	if err != nil {
		return err
	}
	if _, err := service.AmendCommit(patch.ID, message); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}

func latestPatchForMission(service *app.Service, missionID string) (*domain.PatchProposal, error) {
	runs, err := service.ListRunsByMission(missionID)
	if err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return nil, fmt.Errorf("no agent run found for mission: %s", missionID)
	}

	// A mission can span several runs (an AI manager spawns child agents). The
	// patch lives on whichever run produced it, so search newest-first and
	// return the latest patch from the most recent run that has one.
	for i := len(runs) - 1; i >= 0; i-- {
		patches, err := service.ListPatchesByRun(runs[i].ID)
		if err != nil {
			return nil, err
		}
		if len(patches) > 0 {
			return &patches[len(patches)-1], nil
		}
	}

	return nil, fmt.Errorf("no patch proposal found for mission: %s", missionID)
}
