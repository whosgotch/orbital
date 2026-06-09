package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func main() {
	if err := run(context.Background(), os.Args, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) != 4 {
		return fmt.Errorf("usage: orbital <repo-path> <mission-text> <verification-command>")
	}

	repoPath := args[1]
	missionText := args[2]
	verificationCommand := args[3]
	stateDir := filepath.Join(repoPath, ".orbital")

	jsonStore := store.NewJSONStore(stateDir)
	service := app.NewService(jsonStore)

	repository, err := service.OpenRepository(repoPath)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "repository: %s (%s)\n", repository.ID, repository.Path)

	mission, err := service.CreateMission(repository.ID, missionText)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "mission: %s (%s)\n", mission.ID, mission.Status)

	run, err := service.StartAgentRun(ctx, mission.ID, "mock")
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "agent run: %s (%s)\n", run.ID, run.Status)

	patchID, err := firstPatchForRun(jsonStore, run.ID)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "patch proposed: %s\n", patchID)

	approvedPatch, err := service.ApprovePatch(patchID)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "patch approved: %s (%s)\n", approvedPatch.ID, approvedPatch.Status)

	appliedPatch, err := service.ApplyPatch(patchID)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "patch applied: %s (%s)\n", appliedPatch.ID, appliedPatch.Status)

	verification, err := service.RunVerification(ctx, repository.ID, mission.ID, verificationCommand)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "verification: %s (%s)\n", verification.ID, verification.Status)
	if verification.ExitCode != nil {
		fmt.Fprintf(stdout, "exit code: %d\n", *verification.ExitCode)
	}
	if verification.Output != "" {
		fmt.Fprintf(stdout, "output:\n%s\n", verification.Output)
	}

	return nil
}

func firstPatchForRun(jsonStore *store.JSONStore, runID string) (string, error) {
	state, err := jsonStore.Load()
	if err != nil {
		return "", err
	}

	for _, patch := range state.PatchProposals {
		if patch.RunID == runID {
			return patch.ID, nil
		}
	}

	return "", fmt.Errorf("no patch proposal found for run: %s", runID)
}
