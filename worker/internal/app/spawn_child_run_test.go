package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestSpawnChildRunsRecordsChildrenAndMergesPatches(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	registry := agent.NewWorkerRegistry()
	registry.Register(patchingChildWorker{})
	svc := NewServiceWithWorkerRegistry(jsonStore, registry)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{ID: "repo_1", Path: "/tmp/demo", Name: "demo"},
		},
		Missions: []domain.Mission{
			{ID: "mission_1", RepositoryID: "repo_1", Text: "ship a feature", Status: domain.MissionStatusRunning},
		},
		AgentRuns: []domain.AgentRun{
			{ID: "run_manager", MissionID: "mission_1", WorkerName: "manager", Status: domain.AgentRunStatusRunning, StartedAt: time.Now().UTC()},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	ctx := context.Background()
	first, err := svc.SpawnChildRun(ctx, "run_manager", "patching-child", "implement the feature")
	if err != nil {
		t.Fatalf("SpawnChildRun(first) error = %v", err)
	}
	second, err := svc.SpawnChildRun(ctx, "run_manager", "patching-child", "review the feature")
	if err != nil {
		t.Fatalf("SpawnChildRun(second) error = %v", err)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	parent := findRun(t, state.AgentRuns, "run_manager")
	if len(parent.ChildRunIDs) != 2 {
		t.Fatalf("parent child run IDs = %d, want 2", len(parent.ChildRunIDs))
	}

	for _, child := range []*domain.AgentRun{first, second} {
		if child.ParentRunID != "run_manager" {
			t.Fatalf("child %s parent = %q, want %q", child.ID, child.ParentRunID, "run_manager")
		}
		if child.Status != domain.AgentRunStatusCompleted {
			t.Fatalf("child %s status = %q, want %q", child.ID, child.Status, domain.AgentRunStatusCompleted)
		}
	}

	if got := countEvents(state.WorkflowEvents, domain.WorkflowEventChildRunSpawned); got != 2 {
		t.Fatalf("child_run_spawned events = %d, want 2", got)
	}
	if got := countEvents(state.WorkflowEvents, domain.WorkflowEventChildRunCompleted); got != 2 {
		t.Fatalf("child_run_completed events = %d, want 2", got)
	}

	merged, err := svc.MergePatches([]string{first.ID, second.ID})
	if err != nil {
		t.Fatalf("MergePatches() error = %v", err)
	}
	if !strings.Contains(merged.Diff, "implement the feature") || !strings.Contains(merged.Diff, "review the feature") {
		t.Fatalf("merged diff missing child patches: %q", merged.Diff)
	}
	// A missing final newline makes `git apply` read the patch as corrupt.
	if !strings.HasSuffix(merged.Diff, "\n") {
		t.Fatalf("merged diff must end with a newline: %q", merged.Diff)
	}

	state, err = jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if countEvents(state.WorkflowEvents, domain.WorkflowEventPatchesMerged) != 1 {
		t.Fatal("expected one patches_merged event")
	}
}

func findRun(t *testing.T, runs []domain.AgentRun, id string) domain.AgentRun {
	t.Helper()
	for _, run := range runs {
		if run.ID == id {
			return run
		}
	}
	t.Fatalf("run %q not found", id)
	return domain.AgentRun{}
}

func countEvents(events []domain.WorkflowEvent, eventType domain.WorkflowEventType) int {
	count := 0
	for _, event := range events {
		if event.Type == eventType {
			count++
		}
	}
	return count
}

// patchingChildWorker is a stub child agent that emits one pending patch whose
// diff is the task it received, so tests can assert merged output.
type patchingChildWorker struct{}

func (w patchingChildWorker) Name() string { return "patching-child" }

func (w patchingChildWorker) Profile() agent.WorkerProfile {
	return agent.WorkerProfile{Name: w.Name(), Mode: "test"}
}

func (w patchingChildWorker) CheckAvailable(ctx context.Context) (*agent.WorkerInfo, error) {
	return &agent.WorkerInfo{Name: w.Name(), Available: true, Profile: w.Profile()}, nil
}

func (w patchingChildWorker) Supports(ctx context.Context, request agent.RunRequest) agent.SupportResult {
	return agent.SupportResult{Supported: true}
}

func (w patchingChildWorker) StartRun(ctx context.Context, request agent.RunRequest) (<-chan agent.RunEvent, error) {
	events := make(chan agent.RunEvent, 2)
	now := time.Now().UTC()
	events <- agent.RunEvent{PatchProposal: &domain.PatchProposal{
		ID:        fmt.Sprintf("patch_%s", request.RunID),
		RunID:     request.RunID,
		Status:    domain.PatchStatusPending,
		Diff:      request.MissionText,
		CreatedAt: now,
		UpdatedAt: now,
	}}
	events <- agent.RunEvent{WorkflowEvent: &domain.WorkflowEvent{
		ID:        fmt.Sprintf("event_%s", request.RunID),
		RunID:     request.RunID,
		Type:      domain.WorkflowEventRunCompleted,
		Message:   "child completed",
		CreatedAt: now,
	}}
	close(events)
	return events, nil
}

func (w patchingChildWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}
