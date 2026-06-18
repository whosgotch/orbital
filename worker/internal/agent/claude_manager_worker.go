package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

type subtask struct {
	Role string `json:"role"`
	Task string `json:"task"`
}

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

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "Analyzing mission and planning tasks.", "", "claude") {
			return
		}

		tasks, err := w.decomposeMission(ctx, request.MissionText)
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Decomposition failed: %v", err), "", "")
			return
		}

		msg := fmt.Sprintf("Mission decomposed into %d task(s): %s", len(tasks), taskSummary(tasks))
		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRepoInspected, msg, "", "") {
			return
		}

		var childRunIDs []string
		for _, task := range tasks {
			if ctx.Err() != nil {
				sendCancelledEvent(events, request.RunID)
				return
			}

			spawnMsg := fmt.Sprintf("Spawning %s: %s", task.Role, task.Task)
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, spawnMsg, "", "claude") {
				return
			}

			childRun, err := w.spawner.SpawnChildRun(ctx, request.RunID, "claude-engineer", task.Task)
			if err != nil {
				sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Spawn failed: %v", err), "", "")
				return
			}
			childRunIDs = append(childRunIDs, childRun.ID)
		}

		if len(childRunIDs) > 0 {
			if _, err := w.spawner.MergePatches(childRunIDs); err != nil && !strings.Contains(err.Error(), "no pending patches") {
				sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Merge failed: %v", err), "", "")
				return
			}
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Claude Manager completed orchestration.", "", "")
	}()
	return events, nil
}

func (w *ClaudeManagerWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}

func (w *ClaudeManagerWorker) decomposeMission(ctx context.Context, missionText string) ([]subtask, error) {
	system := `You are an AI engineering manager. Decompose the mission into at most 2 specific engineering tasks.

Output ONLY a JSON array. Each element: {"role": "Engineer", "task": "<specific task>"}
No markdown, no explanation — only the JSON array.`

	response, err := callClaude(ctx, system, "Mission: "+missionText)
	if err != nil {
		return nil, err
	}

	var tasks []subtask
	if err := json.Unmarshal([]byte(extractJSONArray(response)), &tasks); err != nil || len(tasks) == 0 {
		// Fallback: single engineer task with the full mission text
		return []subtask{{Role: "Engineer", Task: missionText}}, nil
	}
	if len(tasks) > 2 {
		tasks = tasks[:2]
	}
	return tasks, nil
}

func taskSummary(tasks []subtask) string {
	parts := make([]string, len(tasks))
	for i, t := range tasks {
		parts[i] = fmt.Sprintf("%s (%s)", t.Role, t.Task)
	}
	return strings.Join(parts, "; ")
}
