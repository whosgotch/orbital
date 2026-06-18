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

type ClaudeEngineerWorker struct {
	apiKey string
}

func NewClaudeEngineerWorker(apiKey string) *ClaudeEngineerWorker {
	return &ClaudeEngineerWorker{apiKey: apiKey}
}

func (w *ClaudeEngineerWorker) Name() string { return "claude-engineer" }

func (w *ClaudeEngineerWorker) Profile() WorkerProfile {
	return WorkerProfile{
		Name:  "claude-engineer",
		Mode:  "cloud-api",
		Roles: []string{"Engineer"},
		Capabilities: []string{
			"read repository source files",
			"generate unified diff patches via Claude API",
		},
	}
}

func (w *ClaudeEngineerWorker) CheckAvailable(ctx context.Context) (*WorkerInfo, error) {
	if w.apiKey == "" {
		return &WorkerInfo{Name: w.Name(), Available: false, Reason: "ANTHROPIC_API_KEY not set", Profile: w.Profile()}, nil
	}
	return &WorkerInfo{Name: w.Name(), Available: true, Profile: w.Profile()}, nil
}

func (w *ClaudeEngineerWorker) Supports(ctx context.Context, request RunRequest) SupportResult {
	if w.apiKey == "" {
		return SupportResult{Supported: false, Reason: "ANTHROPIC_API_KEY not set"}
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

		repoContext, readFiles, err := readRepoContext(request.RepoPath)
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Failed to read repo: %v", err), "", "")
			return
		}

		for _, f := range readFiles {
			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventFileRead, fmt.Sprintf("Read %s", f), f, "") {
				return
			}
		}

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "Calling Claude to generate patch.", "", claudeDefaultModel) {
			return
		}

		system := `You are an expert software engineer. Given a task and repository source files, produce a valid unified diff patch.

Rules:
- Output ONLY the diff, starting with "diff --git a/..."
- Use the exact file paths from the context
- If no code change is needed, output an empty string
- Never include explanations, markdown, or any text outside the diff`

		userMsg := fmt.Sprintf("Task: %s\n\nRepository:\n%s", request.MissionText, repoContext)

		diff, err := callClaude(w.apiKey, system, userMsg, 4096)
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Claude API error: %v", err), "", "")
			return
		}

		diff = strings.TrimSpace(diff)
		if diff != "" && strings.HasPrefix(diff, "diff --git") {
			patchPath := filepath.Join(request.RepoPath, ".orbital", "runs", request.RunID, "patch.diff")
			if err := os.MkdirAll(filepath.Dir(patchPath), 0755); err != nil {
				sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Failed to create patch dir: %v", err), "", "")
				return
			}
			if err := os.WriteFile(patchPath, []byte(diff), 0644); err != nil {
				sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Failed to write patch: %v", err), "", "")
				return
			}

			now := time.Now().UTC()
			patch := domain.PatchProposal{
				ID:        fmt.Sprintf("patch_%d", now.UnixNano()),
				RunID:     request.RunID,
				Status:    domain.PatchStatusPending,
				Diff:      diff,
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
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Claude Engineer completed.", "", "")
	}()
	return events, nil
}

func (w *ClaudeEngineerWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}
