package app

import (
	"context"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestStartAgentRunWithMockWorkerSavesRunEventsAndPatch(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{
				ID:   "repo_1",
				Path: "/tmp/demo",
				Name: "demo",
			},
		},
		Missions: []domain.Mission{
			{
				ID:           "mission_1",
				RepositoryID: "repo_1",
				Text:         "add a version command",
				Status:       domain.MissionStatusDraft,
			},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	run, err := svc.StartAgentRun(context.Background(), "mission_1", "mock")
	if err != nil {
		t.Fatalf("StartAgentRun() error = %v", err)
	}

	if run.MissionID != "mission_1" {
		t.Fatalf("run mission ID = %q, want %q", run.MissionID, "mission_1")
	}

	if run.WorkerName != "mock" {
		t.Fatalf("run worker name = %q, want %q", run.WorkerName, "mock")
	}

	if run.Status != domain.AgentRunStatusCompleted {
		t.Fatalf("run status = %q, want %q", run.Status, domain.AgentRunStatusCompleted)
	}

	if run.CompletedAt == nil {
		t.Fatal("expected run completed timestamp")
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(got.AgentRuns) != 1 {
		t.Fatalf("expected 1 agent run, got %d", len(got.AgentRuns))
	}

	if got.AgentRuns[0].ID != run.ID {
		t.Fatalf("saved run ID = %q, want %q", got.AgentRuns[0].ID, run.ID)
	}

	if len(got.WorkflowEvents) != 6 {
		t.Fatalf("expected 6 workflow events, got %d", len(got.WorkflowEvents))
	}

	if len(got.PatchProposals) != 1 {
		t.Fatalf("expected 1 patch proposal, got %d", len(got.PatchProposals))
	}

	if got.PatchProposals[0].RunID != run.ID {
		t.Fatalf("patch run ID = %q, want %q", got.PatchProposals[0].RunID, run.ID)
	}

	if got.Missions[0].Status != domain.MissionStatusWaitingApproval {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusWaitingApproval)
	}
}

func TestStartAgentRunRejectsUnknownMission(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.StartAgentRun(context.Background(), "missing_mission", "mock"); err == nil {
		t.Fatal("expected error for unknown mission, got nil")
	}
}

func TestStartAgentRunRejectsUnknownWorker(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{
				ID:   "repo_1",
				Path: "/tmp/demo",
				Name: "demo",
			},
		},
		Missions: []domain.Mission{
			{
				ID:           "mission_1",
				RepositoryID: "repo_1",
				Text:         "add a version command",
				Status:       domain.MissionStatusDraft,
			},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.StartAgentRun(context.Background(), "mission_1", "missing_worker"); err == nil {
		t.Fatal("expected error for unknown worker, got nil")
	}
}
