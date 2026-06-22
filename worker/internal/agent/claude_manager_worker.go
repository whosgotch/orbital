package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

type ClaudeManagerWorker struct {
	spawner RunSpawner
}

func NewClaudeManagerWorker(spawner RunSpawner) *ClaudeManagerWorker {
	return &ClaudeManagerWorker{spawner: spawner}
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

		// Ask Claude to decompose the mission into an engineering task and a
		// review task. The children run sequentially against the same working
		// tree, so the reviewer refines the engineer's uncommitted changes and
		// the final cumulative diff is what reaches the CEO gate.
		engineerTask := request.MissionText
		reviewerTask := "Review the engineer's changes for correctness, edge cases, and clarity, and refine them where needed."

		if plan, err := callClaudePlan(ctx, request.RepoPath, request.MissionText); err != nil {
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "Planning unavailable; delegating the mission directly to the Engineer.", "", "claude") {
				return
			}
		} else {
			if strings.TrimSpace(plan.EngineerTask) != "" {
				engineerTask = plan.EngineerTask
			}
			if strings.TrimSpace(plan.ReviewerTask) != "" {
				reviewerTask = plan.ReviewerTask
			}
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted,
				fmt.Sprintf("🧭 Plan — Engineer: %s | Reviewer: %s", truncate(engineerTask, 120), truncate(reviewerTask, 120)), "", "claude") {
				return
			}
		}

		if !w.delegate(ctx, events, request.RunID, "claude-engineer", "Engineer", engineerTask) {
			return
		}
		if !w.delegate(ctx, events, request.RunID, "claude-reviewer", "Reviewer", reviewerTask) {
			return
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Claude Manager completed orchestration.", "", "")
	}()
	return events, nil
}

// delegate spawns one child agent and waits for it (SpawnChildRun is
// synchronous). It returns false if the run should stop — on cancellation or a
// spawn failure — after emitting the appropriate event.
func (w *ClaudeManagerWorker) delegate(ctx context.Context, events chan<- RunEvent, runID, worker, role, task string) bool {
	if ctx.Err() != nil {
		sendCancelledEvent(events, runID)
		return false
	}
	if !sendWorkflowEvent(ctx, events, runID, domain.WorkflowEventCommandExecuted, fmt.Sprintf("Delegating to %s.", role), "", "claude") {
		return false
	}
	if _, err := w.spawner.SpawnChildRun(ctx, runID, worker, task); err != nil {
		sendWorkflowEvent(ctx, events, runID, domain.WorkflowEventRunFailed, fmt.Sprintf("%s failed: %v", role, err), "", "")
		return false
	}
	return true
}

func (w *ClaudeManagerWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}
