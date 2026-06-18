package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

type ClaudeEngineerWorker struct{}

func NewClaudeEngineerWorker() *ClaudeEngineerWorker {
	return &ClaudeEngineerWorker{}
}

func (w *ClaudeEngineerWorker) Name() string { return "claude-engineer" }

func (w *ClaudeEngineerWorker) Profile() WorkerProfile {
	return WorkerProfile{
		Name:  "claude-engineer",
		Mode:  "claude-cli",
		Roles: []string{"Engineer"},
		Capabilities: []string{
			"edit repository files via claude CLI",
			"capture changes as a unified diff for review",
		},
	}
}

func (w *ClaudeEngineerWorker) CheckAvailable(ctx context.Context) (*WorkerInfo, error) {
	if !claudeCLIAvailable() {
		return &WorkerInfo{Name: w.Name(), Available: false, Reason: "claude CLI not found in PATH", Profile: w.Profile()}, nil
	}
	return &WorkerInfo{Name: w.Name(), Available: true, Profile: w.Profile()}, nil
}

func (w *ClaudeEngineerWorker) Supports(ctx context.Context, request RunRequest) SupportResult {
	if !claudeCLIAvailable() {
		return SupportResult{Supported: false, Reason: "claude CLI not found in PATH"}
	}
	return SupportResult{Supported: true}
}

func (w *ClaudeEngineerWorker) StartRun(ctx context.Context, request RunRequest) (<-chan RunEvent, error) {
	events := make(chan RunEvent)
	go func() {
		defer close(events)

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunStarted, "Claude Engineer started.", "", "") {
			return
		}

		if err := ensureGitRepo(ctx, request.RepoPath); err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Git init failed: %v", err), "", "")
			return
		}

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "Claude is editing the repository.", "", "claude") {
			return
		}

		prompt := fmt.Sprintf(`You are an autonomous software engineer working in this repository.

Task: %s

Make the necessary code changes directly by editing files. Keep the change focused and minimal. Do not commit. When done, briefly summarize what you changed.`, request.MissionText)

		summary, err := callClaudeAgentic(ctx, request.RepoPath, prompt)
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Claude error: %v", err), "", "")
			return
		}

		if strings.TrimSpace(summary) != "" {
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, truncate(summary, 200), "", "claude") {
				return
			}
		}

		diff, err := captureGitDiff(ctx, request.RepoPath)
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Capture diff failed: %v", err), "", "")
			return
		}

		diff = strings.TrimSpace(diff)
		if diff != "" {
			patchPath := filepath.Join(request.RepoPath, ".orbital", "runs", request.RunID, "patch.diff")
			if err := os.MkdirAll(filepath.Dir(patchPath), 0755); err != nil {
				sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Failed to create patch dir: %v", err), "", "")
				return
			}
			if err := os.WriteFile(patchPath, []byte(diff+"\n"), 0644); err != nil {
				sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Failed to write patch: %v", err), "", "")
				return
			}

			now := time.Now().UTC()
			patch := domain.PatchProposal{
				ID:        fmt.Sprintf("patch_%d", now.UnixNano()),
				RunID:     request.RunID,
				Status:    domain.PatchStatusPending,
				Diff:      diff + "\n",
				CreatedAt: now,
				UpdatedAt: now,
			}

			select {
			case <-ctx.Done():
				sendCancelledEvent(events, request.RunID)
				return
			case events <- RunEvent{PatchProposal: &patch}:
			}

			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventPatchProposed, "Claude Engineer produced a patch.", patchPath, "") {
				return
			}
		} else {
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "No file changes were produced.", "", "") {
				return
			}
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Claude Engineer completed.", "", "")
	}()
	return events, nil
}

func (w *ClaudeEngineerWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
