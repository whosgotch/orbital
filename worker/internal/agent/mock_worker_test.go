package agent

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func TestMockWorkerCheckAvailable(t *testing.T) {
	worker := NewMockWorker()

	info, err := worker.CheckAvailable(context.Background())
	if err != nil {
		t.Fatalf("CheckAvailable() error = %v", err)
	}

	if !info.Available {
		t.Fatal("expected mock worker to be available")
	}

	if info.Name != "mock" {
		t.Fatalf("worker name = %q, want %q", info.Name, "mock")
	}
}

func TestMockWorkerStartRunEmitsEventsAndPatch(t *testing.T) {
	worker := NewMockWorker()

	events, err := worker.StartRun(context.Background(), RunRequest{
		RunID:       "run_1",
		MissionID:   "mission_1",
		RepoPath:    "/tmp/demo",
		MissionText: "add a version command",
	})
	if err != nil {
		t.Fatalf("StartRun() error = %v", err)
	}

	var eventTypes []domain.WorkflowEventType
	var patchCount int

	for event := range events {
		if event.WorkflowEvent != nil {
			eventTypes = append(eventTypes, event.WorkflowEvent.Type)
		}

		if event.PatchProposal != nil {
			patchCount++
			if event.PatchProposal.Status != domain.PatchStatusPending {
				t.Fatalf("patch status = %q, want %q", event.PatchProposal.Status, domain.PatchStatusPending)
			}
		}
	}

	if patchCount != 1 {
		t.Fatalf("expected 1 patch proposal, got %d", patchCount)
	}

	want := []domain.WorkflowEventType{
		domain.WorkflowEventRunStarted,
		domain.WorkflowEventRepoInspected,
		domain.WorkflowEventFileRead,
		domain.WorkflowEventFileRead,
		domain.WorkflowEventPatchProposed,
		domain.WorkflowEventRunCompleted,
	}

	if len(eventTypes) != len(want) {
		t.Fatalf("expected %d workflow events, got %d", len(want), len(eventTypes))
	}

	for index, wantType := range want {
		if eventTypes[index] != wantType {
			t.Fatalf("event type at index %d = %q, want %q", index, eventTypes[index], wantType)
		}
	}
}

func TestMockWorkerPatchAppliesWithGitApply(t *testing.T) {
	repoDir := t.TempDir()
	srcDir := filepath.Join(repoDir, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "package.json"), []byte(mockPackageJSON), 0644); err != nil {
		t.Fatalf("WriteFile(package.json) error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(srcDir, "cli.ts"), []byte(mockCLI), 0644); err != nil {
		t.Fatalf("WriteFile(cli.ts) error = %v", err)
	}

	cmd := exec.Command("git", "apply")
	cmd.Dir = repoDir
	cmd.Stdin = strings.NewReader(mockVersionCommandDiff)

	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git apply error = %v, output = %s", err, string(output))
	}
}

const mockPackageJSON = `{
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

const mockCLI = `import pkg from "../package.json";

const command = process.argv[2];

console.log("Usage: demo <command>");
`
