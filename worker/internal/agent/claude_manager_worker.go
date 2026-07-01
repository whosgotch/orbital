package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

type ClaudeManagerWorker struct {
	spawner RunSpawner
	// decompose splits a mission into sub-tasks; a field so tests can drive the
	// orchestration without invoking the Claude CLI.
	decompose func(ctx context.Context, repoPath, mission string) ([]subTask, error)
}

func NewClaudeManagerWorker(spawner RunSpawner) *ClaudeManagerWorker {
	return &ClaudeManagerWorker{spawner: spawner, decompose: callClaudeDecompose}
}

func (w *ClaudeManagerWorker) Name() string { return "claude-manager" }

func (w *ClaudeManagerWorker) Profile() WorkerProfile {
	return WorkerProfile{
		Name:  "claude-manager",
		Mode:  "claude-cli",
		Roles: []string{"AI Manager"},
		Capabilities: []string{
			"decompose missions into engineering and review tasks via Claude",
			"spawn and coordinate specialized child agents",
			"deliver a single reviewed patch for human approval",
		},
	}
}

func (w *ClaudeManagerWorker) CheckAvailable(ctx context.Context) (*WorkerInfo, error) {
	if !claudeCLIAvailable() {
		return &WorkerInfo{Name: w.Name(), Available: false, Reason: "claude CLI not found in PATH", Profile: w.Profile()}, nil
	}
	return &WorkerInfo{Name: w.Name(), Available: true, Profile: w.Profile()}, nil
}

func (w *ClaudeManagerWorker) Supports(ctx context.Context, request RunRequest) SupportResult {
	if !claudeCLIAvailable() {
		return SupportResult{Supported: false, Reason: "claude CLI not found in PATH"}
	}
	return SupportResult{Supported: true}
}

func (w *ClaudeManagerWorker) StartRun(ctx context.Context, request RunRequest) (<-chan RunEvent, error) {
	events := make(chan RunEvent)
	go func() {
		defer close(events)

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunStarted, "Claude Manager accepted the mission.", "", "") {
			return
		}

		// Decompose only when the work genuinely has independent parts. A focused
		// mission comes back as a single task and runs as one engineer — no padded
		// steps, no separate review/verify agent (the human CEO gate and the
		// optional verification stage cover that). Each task is an engineer that
		// runs in sequence on the same working tree, so the cumulative diff is what
		// reaches the gate.
		tasks, err := w.decompose(ctx, request.RepoPath, request.MissionText)
		if err != nil || len(tasks) == 0 {
			// Planning unavailable: hand the whole mission to a single engineer.
			tasks = []subTask{{Title: "Engineer", Prompt: request.MissionText}}
		}

		if len(tasks) == 1 {
			if _, ok := w.delegate(ctx, events, request.RunID, tasks[0]); !ok {
				return
			}
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Claude Manager completed orchestration.", "", "")
			return
		}

		// Genuinely multi-part: run an engineer for each part IN PARALLEL, each in
		// its own worktree, then merge their diffs into the single patch the CEO
		// gate reviews.
		titles := make([]string, len(tasks))
		for index, task := range tasks {
			titles[index] = task.Title
		}
		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted,
			fmt.Sprintf("🧭 Split into %d parts, running in parallel: %s", len(tasks), strings.Join(titles, " · ")), "", "claude") {
			return
		}

		var wg sync.WaitGroup
		childIDs := make([]string, len(tasks))
		for index := range tasks {
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				if run, ok := w.delegate(ctx, events, request.RunID, tasks[index]); ok {
					childIDs[index] = run.ID
				}
			}(index)
		}
		wg.Wait()

		completed := make([]string, 0, len(childIDs))
		for _, id := range childIDs {
			if id != "" {
				completed = append(completed, id)
			}
		}
		if len(completed) == 0 {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, "Every part failed.", "", "")
			return
		}

		// Converge the parallel diffs. If nothing produced changes, there's simply
		// no patch to review — not a failure.
		if len(completed) > 1 {
			if _, err := w.spawner.MergePatches(completed); err != nil {
				sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "No changes to merge.", "", "claude")
			}
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Claude Manager completed orchestration.", "", "")
	}()
	return events, nil
}

// delegate spawns one engineer for a task and waits for it (SpawnChildRun is
// synchronous). It returns the child run on success; on cancellation or a spawn
// failure it returns (nil, false) after emitting the appropriate event.
func (w *ClaudeManagerWorker) delegate(ctx context.Context, events chan<- RunEvent, runID string, task subTask) (*domain.AgentRun, bool) {
	if ctx.Err() != nil {
		sendCancelledEvent(events, runID)
		return nil, false
	}
	label := strings.TrimSpace(task.Title)
	if label == "" {
		label = "the Engineer"
	}
	if !sendWorkflowEvent(ctx, events, runID, domain.WorkflowEventCommandExecuted, fmt.Sprintf("Delegating to %s.", label), "", "claude") {
		return nil, false
	}
	run, err := w.spawner.SpawnChildRun(ctx, runID, "claude-engineer", task.Prompt)
	if err != nil {
		sendWorkflowEvent(ctx, events, runID, domain.WorkflowEventRunFailed, fmt.Sprintf("%s failed: %v", label, err), "", "")
		return nil, false
	}
	return run, true
}

func (w *ClaudeManagerWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}
