package agent

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

// fakeSpawner records SpawnChildRun / MergePatches calls so we can assert how the
// manager orchestrates parts, without running real agents. failTasks names the
// tasks whose spawn should fail, to exercise partial- and total-failure paths.
type fakeSpawner struct {
	mu        sync.Mutex
	spawned   []string // task prompts, in completion order
	mergedRun []string // run IDs passed to MergePatches
	mergeN    int
	failTasks map[string]bool
}

func (f *fakeSpawner) SpawnChildRun(ctx context.Context, parentRunID, workerName, task string) (*domain.AgentRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failTasks[task] {
		return nil, fmt.Errorf("spawn failed for %q", task)
	}
	f.spawned = append(f.spawned, task)
	return &domain.AgentRun{ID: fmt.Sprintf("run_%d", len(f.spawned)), ParentRunID: parentRunID, WorkerName: workerName}, nil
}

func (f *fakeSpawner) MergePatches(runIDs []string) (*domain.PatchProposal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mergeN++
	f.mergedRun = runIDs
	return &domain.PatchProposal{ID: "merged"}, nil
}

func runManager(t *testing.T, tasks []subTask, fail map[string]bool) (*fakeSpawner, []domain.WorkflowEventType) {
	t.Helper()
	spawner := &fakeSpawner{failTasks: fail}
	w := NewClaudeManagerWorker(spawner)
	w.decompose = func(ctx context.Context, repoPath, mission, model string) ([]subTask, error) {
		return tasks, nil
	}

	events, err := w.StartRun(context.Background(), RunRequest{RunID: "run_manager", MissionText: "do it"})
	if err != nil {
		t.Fatalf("StartRun() error = %v", err)
	}
	var types []domain.WorkflowEventType
	for event := range events {
		if event.WorkflowEvent != nil {
			types = append(types, event.WorkflowEvent.Type)
		}
	}
	return spawner, types
}

func hasEvent(types []domain.WorkflowEventType, want domain.WorkflowEventType) bool {
	for _, t := range types {
		if t == want {
			return true
		}
	}
	return false
}

func TestManagerSingleTaskRunsOneEngineerNoMerge(t *testing.T) {
	spawner, types := runManager(t, []subTask{{Title: "Do the thing", Prompt: "do the thing"}}, nil)

	if len(spawner.spawned) != 1 {
		t.Fatalf("spawned %d engineers, want 1", len(spawner.spawned))
	}
	if spawner.mergeN != 0 {
		t.Fatalf("MergePatches called %d times, want 0 for a single task", spawner.mergeN)
	}
	if !hasEvent(types, domain.WorkflowEventRunCompleted) {
		t.Fatal("expected a run_completed event")
	}
}

func TestManagerMultiPartRunsAllEngineersAndMerges(t *testing.T) {
	spawner, types := runManager(t, []subTask{
		{Title: "A", Prompt: "part a"},
		{Title: "B", Prompt: "part b"},
		{Title: "C", Prompt: "part c"},
	}, nil)

	if len(spawner.spawned) != 3 {
		t.Fatalf("spawned %d engineers, want 3", len(spawner.spawned))
	}
	if spawner.mergeN != 1 {
		t.Fatalf("MergePatches called %d times, want 1", spawner.mergeN)
	}
	if len(spawner.mergedRun) != 3 {
		t.Fatalf("merged %d runs, want 3", len(spawner.mergedRun))
	}
	if !hasEvent(types, domain.WorkflowEventRunCompleted) {
		t.Fatal("expected a run_completed event")
	}
}

func TestManagerPartialFailureMergesSurvivorsOnly(t *testing.T) {
	// Two of three parts succeed → still merge the two survivors.
	spawner, types := runManager(t, []subTask{
		{Title: "A", Prompt: "part a"},
		{Title: "B", Prompt: "part b"},
		{Title: "C", Prompt: "part c"},
	}, map[string]bool{"part b": true})

	if len(spawner.spawned) != 2 {
		t.Fatalf("spawned %d engineers, want 2 survivors", len(spawner.spawned))
	}
	if spawner.mergeN != 1 || len(spawner.mergedRun) != 2 {
		t.Fatalf("expected one merge of 2 survivors, got merges=%d runs=%d", spawner.mergeN, len(spawner.mergedRun))
	}
	if !hasEvent(types, domain.WorkflowEventRunCompleted) {
		t.Fatal("expected a run_completed event")
	}
}

func TestManagerSingleSurvivorSkipsMerge(t *testing.T) {
	// Only one of two parts succeeds → its patch reaches the gate directly.
	spawner, _ := runManager(t, []subTask{
		{Title: "A", Prompt: "part a"},
		{Title: "B", Prompt: "part b"},
	}, map[string]bool{"part a": true})

	if len(spawner.spawned) != 1 {
		t.Fatalf("spawned %d engineers, want 1 survivor", len(spawner.spawned))
	}
	if spawner.mergeN != 0 {
		t.Fatalf("MergePatches called %d times, want 0 for a single survivor", spawner.mergeN)
	}
}

func TestManagerAllPartsFailMarksRunFailed(t *testing.T) {
	spawner, types := runManager(t, []subTask{
		{Title: "A", Prompt: "part a"},
		{Title: "B", Prompt: "part b"},
	}, map[string]bool{"part a": true, "part b": true})

	if len(spawner.spawned) != 0 {
		t.Fatalf("spawned %d engineers, want 0", len(spawner.spawned))
	}
	if spawner.mergeN != 0 {
		t.Fatalf("MergePatches called %d times, want 0", spawner.mergeN)
	}
	if !hasEvent(types, domain.WorkflowEventRunFailed) {
		t.Fatal("expected a run_failed event when every part fails")
	}
	if hasEvent(types, domain.WorkflowEventRunCompleted) {
		t.Fatal("did not expect run_completed when every part fails")
	}
}
