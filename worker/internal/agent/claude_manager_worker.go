package agent

import (
	"context"
	"fmt"

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
			"decompose missions into engineering tasks via Claude API",
			"spawn and coordinate specialized child agents",
			"merge patches from multiple child runs",
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

		if ctx.Err() != nil {
			sendCancelledEvent(events, request.RunID)
			return
		}

		// Delegate the mission to a single agentic engineer. A separate planning
		// call adds a slow round-trip with no value here since the engineer plans
		// and edits in one pass. Multi-agent fan-out across isolated git worktrees
		// comes in a later milestone.
		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "Delegating mission to Engineer.", "", "claude") {
			return
		}

		if _, err := w.spawner.SpawnChildRun(ctx, request.RunID, "claude-engineer", request.MissionText); err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Spawn failed: %v", err), "", "")
			return
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Claude Manager completed orchestration.", "", "")
	}()
	return events, nil
}

func (w *ClaudeManagerWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}
