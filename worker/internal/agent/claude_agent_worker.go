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

// claudeAgentWorker is a Claude-backed agent that edits the repository working
// tree directly and captures its changes as a patch proposal. The role and
// prompt distinguish the specialized agents (Engineer, Reviewer) that the
// manager runs in sequence against the same tree.
type claudeAgentWorker struct {
	name        string
	role        string
	startLabel  string
	buildPrompt func(task string) string
}

func NewClaudeEngineerWorker() *claudeAgentWorker {
	return &claudeAgentWorker{
		name:       "claude-engineer",
		role:       "Engineer",
		startLabel: "Claude Engineer started.",
		buildPrompt: func(task string) string {
			return fmt.Sprintf(`You are an autonomous software engineer working in this repository.

Task: %s

Make the necessary code changes directly by editing files. Keep the change focused and minimal. Do not commit. When done, briefly summarize what you changed.`, task)
		},
	}
}

func NewClaudeReviewerWorker() *claudeAgentWorker {
	return &claudeAgentWorker{
		name:       "claude-reviewer",
		role:       "Reviewer",
		startLabel: "Claude Reviewer started.",
		buildPrompt: func(task string) string {
			return fmt.Sprintf(`You are a senior code reviewer working in this repository. An engineer has just made uncommitted changes to address a mission. Inspect the current changes with the git diff and the surrounding code.

Review focus: %s

Improve correctness, handle edge cases, and tighten naming and style by editing files directly. Build on the engineer's work — do not revert it or start over. Keep refinements minimal and focused. Do not commit. When done, briefly summarize what you refined.`, task)
		},
	}
}

func (w *claudeAgentWorker) Name() string { return w.name }

func (w *claudeAgentWorker) Profile() WorkerProfile {
	return WorkerProfile{
		Name:  w.name,
		Mode:  "claude-cli",
		Roles: []string{w.role},
		Capabilities: []string{
			"edit repository files via claude CLI",
			"capture changes as a unified diff for review",
		},
	}
}

func (w *claudeAgentWorker) CheckAvailable(ctx context.Context) (*WorkerInfo, error) {
	if !claudeCLIAvailable() {
		return &WorkerInfo{Name: w.name, Available: false, Reason: "claude CLI not found in PATH", Profile: w.Profile()}, nil
	}
	return &WorkerInfo{Name: w.name, Available: true, Profile: w.Profile()}, nil
}

func (w *claudeAgentWorker) Supports(ctx context.Context, request RunRequest) SupportResult {
	if !claudeCLIAvailable() {
		return SupportResult{Supported: false, Reason: "claude CLI not found in PATH"}
	}
	return SupportResult{Supported: true}
}

func (w *claudeAgentWorker) StartRun(ctx context.Context, request RunRequest) (<-chan RunEvent, error) {
	events := make(chan RunEvent)
	go func() {
		defer close(events)

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunStarted, w.startLabel, "", "") {
			return
		}

		if err := ensureGitRepo(ctx, request.RepoPath); err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Git init failed: %v", err), "", "")
			return
		}

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, fmt.Sprintf("Claude %s is working in the repository.", w.role), "", "claude") {
			return
		}

		// Stream Claude's reasoning (thoughts) and actions (edits, commands) into
		// the feed, tagged so the Agent transcript can render them distinctly.
		summary, _, err := callClaudeAgentic(ctx, request.RepoPath, "", w.buildPrompt(request.MissionText), func(kind, msg string) {
			eventType := domain.WorkflowEventAgentAction
			if kind == "thought" {
				eventType = domain.WorkflowEventAgentThought
			}
			sendWorkflowEvent(ctx, events, request.RunID, eventType, msg, "", "claude")
		})
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Claude error: %v", err), "", "")
			return
		}

		if strings.TrimSpace(summary) != "" {
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "✅ "+truncate(summary, 200), "", "claude") {
				return
			}
		}

		diff, err := captureGitDiff(ctx, request.RepoPath)
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Capture diff failed: %v", err), "", "")
			return
		}

		diff = normalizeCapturedDiff(diff)
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

			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventPatchProposed, fmt.Sprintf("Claude %s produced a patch.", w.role), patchPath, "") {
				return
			}
		} else {
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "No file changes were produced.", "", "") {
				return
			}
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, fmt.Sprintf("Claude %s completed.", w.role), "", "")
	}()
	return events, nil
}

func (w *claudeAgentWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}

// normalizeCapturedDiff trims only the trailing newline(s) git appends, so the
// caller can re-add exactly one. It must NOT use strings.TrimSpace: when a
// hunk's last context line mirrors a blank line in the file, git writes it as a
// lone space (" \n"); TrimSpace would eat that space-only line, leaving the
// body one line short of what the hunk header counts and making git apply fail
// with "corrupt patch". TrimRight on "\n" preserves the space.
func normalizeCapturedDiff(diff string) string {
	return strings.TrimRight(diff, "\n")
}
