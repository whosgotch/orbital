package app

import (
	"context"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
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

	for _, event := range got.WorkflowEvents {
		if event.MissionID != "mission_1" {
			t.Fatalf("event mission ID = %q, want %q", event.MissionID, "mission_1")
		}
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

func TestStartAgentRunPersistsProgressBeforeRunCompletes(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	worker := newBlockingWorker()
	registry := agent.NewWorkerRegistry()
	registry.Register(worker)
	svc := NewServiceWithWorkerRegistry(jsonStore, registry)

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

	type runResult struct {
		run *domain.AgentRun
		err error
	}
	result := make(chan runResult, 1)
	go func() {
		run, err := svc.StartAgentRun(context.Background(), "mission_1", "blocking")
		result <- runResult{run: run, err: err}
	}()

	got := waitForSavedRunProgress(t, jsonStore)
	if got.AgentRuns[0].Status != domain.AgentRunStatusRunning {
		t.Fatalf("run status = %q, want %q", got.AgentRuns[0].Status, domain.AgentRunStatusRunning)
	}
	if got.Missions[0].Status != domain.MissionStatusRunning {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusRunning)
	}
	if len(got.WorkflowEvents) != 1 {
		t.Fatalf("expected 1 workflow event before completion, got %d", len(got.WorkflowEvents))
	}

	worker.finish()

	select {
	case result := <-result:
		if result.err != nil {
			t.Fatalf("StartAgentRun() error = %v", result.err)
		}
		if result.run.Status != domain.AgentRunStatusCompleted {
			t.Fatalf("run status = %q, want %q", result.run.Status, domain.AgentRunStatusCompleted)
		}
	case <-time.After(time.Second):
		t.Fatal("StartAgentRun() did not complete")
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

func waitForSavedRunProgress(t *testing.T, jsonStore *store.JSONStore) *store.State {
	t.Helper()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		state, err := jsonStore.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}

		if len(state.AgentRuns) == 1 && len(state.WorkflowEvents) == 1 {
			return state
		}

		time.Sleep(10 * time.Millisecond)
	}

	t.Fatal("timed out waiting for saved run progress")
	return nil
}

type blockingWorker struct {
	release chan struct{}
}

func newBlockingWorker() *blockingWorker {
	return &blockingWorker{
		release: make(chan struct{}),
	}
}

func (w *blockingWorker) Name() string {
	return "blocking"
}

func (w *blockingWorker) CheckAvailable(ctx context.Context) (*agent.WorkerInfo, error) {
	return &agent.WorkerInfo{
		Name:      w.Name(),
		Available: true,
	}, nil
}

func (w *blockingWorker) StartRun(ctx context.Context, request agent.RunRequest) (<-chan agent.RunEvent, error) {
	events := make(chan agent.RunEvent)

	go func() {
		defer close(events)

		events <- agent.RunEvent{
			WorkflowEvent: &domain.WorkflowEvent{
				ID:        "event_1",
				RunID:     request.RunID,
				Type:      domain.WorkflowEventRunStarted,
				Message:   "Blocking worker started.",
				CreatedAt: time.Now().UTC(),
			},
		}

		<-w.release
	}()

	return events, nil
}

func (w *blockingWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}

func (w *blockingWorker) finish() {
	close(w.release)
}
