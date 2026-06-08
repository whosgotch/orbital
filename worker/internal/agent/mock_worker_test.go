package agent

import (
	"context"
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
