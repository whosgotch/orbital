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
	if len(args) < 2 {
		return usageError()
	}

	switch args[1] {
	case "run":
		return runMission(ctx, args, stdout)
	case "demo-fixture":
		return createDemoFixture(args, stdout)
	default:
		return usageError()
	}
}

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

func createDemoFixture(args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return usageError()
	}

	repoPath := args[2]
	srcDir := filepath.Join(repoPath, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(repoPath, "package.json"), []byte(demoPackageJSON), 0644); err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(srcDir, "cli.ts"), []byte(demoCLI), 0644); err != nil {
		return err
	}

	if err := os.RemoveAll(filepath.Join(repoPath, ".orbital")); err != nil {
		return err
	}

	fmt.Fprintf(stdout, "demo fixture ready: %s\n", repoPath)
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

func usageError() error {
	return fmt.Errorf("usage: orbital run <repo-path> <mission-text> <verification-command>\n       orbital demo-fixture <repo-path>")
}

const demoPackageJSON = `{
  "name": "demo",
  "type": "module",
  "bin": {
    "demo": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  }
}
`

const demoCLI = `import pkg from "../package.json";

const command = process.argv[2];

console.log("Usage: demo <command>");
`
