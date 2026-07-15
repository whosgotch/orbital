package main

import (
	"context"
	"fmt"
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func runMission(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) != 5 {
		return usageError()
	}

	repoPath := args[2]
	missionText := args[3]
	verificationCommand := args[4]
	stateDir := filepath.Join(repoPath, ".orbital")

	jsonStore := store.NewJSONStore(stateDir)
	service := app.NewService(jsonStore)

	repository, err := service.OpenRepository(repoPath)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "repository: %s (%s)\n", repository.ID, repository.Path)

	mission, err := service.CreateMission(repository.ID, missionText, "")
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "mission: %s (%s)\n", mission.ID, mission.Status)

	run, err := service.StartAgentRun(ctx, mission.ID, "mock")
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "agent run: %s (%s)\n", run.ID, run.Status)

	patchID, err := firstPatchForRun(service, run.ID)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "patch proposed: %s\n", patchID)

	approvedPatch, err := service.ApprovePatch(patchID)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "patch approved: %s (%s)\n", approvedPatch.ID, approvedPatch.Status)

	appliedPatch, err := service.ApplyPatch(patchID)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "patch applied: %s (%s)\n", appliedPatch.ID, appliedPatch.Status)

	verification, err := service.RunVerification(ctx, repository.ID, mission.ID, verificationCommand)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "verification: %s (%s)\n", verification.ID, verification.Status)
	if verification.ExitCode != nil {
		_, _ = fmt.Fprintf(stdout, "exit code: %d\n", *verification.ExitCode)
	}
	if verification.Output != "" {
		_, _ = fmt.Fprintf(stdout, "output:\n%s\n", verification.Output)
	}

	events, err := service.ListEventsByMission(mission.ID)
	if err != nil {
		return err
	}
	printTimeline(stdout, events)

	return nil
}

func firstPatchForRun(service *app.Service, runID string) (string, error) {
	patches, err := service.ListPatchesByRun(runID)
	if err != nil {
		return "", err
	}

	if len(patches) == 0 {
		return "", fmt.Errorf("no patch proposal found for run: %s", runID)
	}

	return patches[0].ID, nil
}
