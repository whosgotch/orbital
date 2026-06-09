package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestCreateDemoFixtureResetsFilesAndState(t *testing.T) {
	repoDir := t.TempDir()
	stateDir := filepath.Join(repoDir, ".orbital")
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		t.Fatalf("MkdirAll(.orbital) error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(stateDir, "state.json"), []byte("{}"), 0644); err != nil {
		t.Fatalf("WriteFile(state.json) error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "package.json"), []byte(`{"version":"0.1.0"}`), 0644); err != nil {
		t.Fatalf("WriteFile(package.json) error = %v", err)
	}

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "demo-fixture", repoDir}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	packageJSON, err := os.ReadFile(filepath.Join(repoDir, "package.json"))
	if err != nil {
		t.Fatalf("ReadFile(package.json) error = %v", err)
	}

	if string(packageJSON) != demoPackageJSON {
		t.Fatalf("package.json = %q, want fixture content", string(packageJSON))
	}

	cli, err := os.ReadFile(filepath.Join(repoDir, "src", "cli.ts"))
	if err != nil {
		t.Fatalf("ReadFile(cli.ts) error = %v", err)
	}

	if string(cli) != demoCLI {
		t.Fatalf("cli.ts = %q, want fixture content", string(cli))
	}

	if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
		t.Fatalf("expected .orbital to be removed, stat error = %v", err)
	}

	if output.String() == "" {
		t.Fatal("expected fixture command output")
	}
}

func TestRunRejectsUnknownCommand(t *testing.T) {
	if err := run(context.Background(), []string{"orbital", "unknown"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected usage error, got nil")
	}
}

func TestStatusPrintsSavedWorkflowState(t *testing.T) {
	repoDir := t.TempDir()
	jsonStore := store.NewJSONStore(filepath.Join(repoDir, ".orbital"))
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{ID: "repo_1", Path: repoDir, Name: "demo"},
		},
		Missions: []domain.Mission{
			{ID: "mission_1", RepositoryID: "repo_1", Status: domain.MissionStatusVerified},
		},
		AgentRuns: []domain.AgentRun{
			{ID: "run_1", MissionID: "mission_1", Status: domain.AgentRunStatusCompleted},
		},
		PatchProposals: []domain.PatchProposal{
			{ID: "patch_1", RunID: "run_1", Status: domain.PatchStatusApplied},
		},
		VerificationRuns: []domain.VerificationRun{
			{ID: "verification_1", MissionID: "mission_1", Status: domain.VerificationStatusPassed},
		},
		WorkflowEvents: []domain.WorkflowEvent{
			{
				ID:        "event_1",
				MissionID: "mission_1",
				Type:      domain.WorkflowEventVerificationPassed,
				Message:   "Verification passed.",
			},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "status", repoDir}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	want := "repository: repo_1 (" + repoDir + ")\n" +
		"mission: mission_1 (verified)\n" +
		"  run: run_1 (completed)\n" +
		"    patch: patch_1 (applied)\n" +
		"  verification: verification_1 (passed)\n" +
		"timeline:\n" +
		"- verification_passed: Verification passed.\n"
	if output.String() != want {
		t.Fatalf("status output = %q, want %q", output.String(), want)
	}
}

func TestPrintTimeline(t *testing.T) {
	var output bytes.Buffer

	printTimeline(&output, []domain.WorkflowEvent{
		{
			Type:    domain.WorkflowEventRunStarted,
			Message: "Mock worker started.",
		},
		{
			Type:    domain.WorkflowEventPatchApplied,
			Message: "Patch applied.",
		},
	})

	want := "timeline:\n- run_started: Mock worker started.\n- patch_applied: Patch applied.\n"
	if output.String() != want {
		t.Fatalf("timeline output = %q, want %q", output.String(), want)
	}
}
