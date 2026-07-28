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

// claudeAgentWorker is a Claude-backed agent working in the repository. The
// role and prompt distinguish the specialized agents; capturesPatch separates
// engineers (whose deliverable is a diff) from researchers (whose deliverable
// is the written reply itself).
type claudeAgentWorker struct {
	name             string
	role             string
	startLabel       string
	capturesPatch    bool
	deliversFindings bool
	buildPrompt      func(task string) string
}

func NewClaudeEngineerWorker() *claudeAgentWorker {
	return &claudeAgentWorker{
		name:          "claude-engineer",
		role:          "Engineer",
		startLabel:    "Claude Engineer started.",
		capturesPatch: true,
		buildPrompt: func(task string) string {
			return fmt.Sprintf(`You are an autonomous software engineer working in this repository.

Task: %s

Make the necessary code changes directly by editing files. Keep the change focused and minimal. Do not commit.

When done, briefly summarize what you changed, then end your reply with a Conventional Commits subject line for this exact diff, in this exact tag:
<commit>type(scope): subject</commit>
One line, imperative mood, no trailing period, no AI attribution. type is feat/fix/refactor/chore/docs/test/style as fits; scope is the touched area (e.g. app, worker).`, task)
		},
	}
}

// NewClaudeResearcherWorker answers questions about the repository instead of
// changing it. Each reply carries two parts: a short chat note and the full
// findings document, which the service stores on the mission — so the Document
// panel always shows the current version while the chat stays a conversation.
func NewClaudeResearcherWorker() *claudeAgentWorker {
	return &claudeAgentWorker{
		name:             "claude-researcher",
		role:             "Researcher",
		startLabel:       "Claude Researcher started.",
		capturesPatch:    false,
		deliversFindings: true,
		buildPrompt: func(task string) string {
			return fmt.Sprintf(`You are a researcher exploring the repository in the current directory. Read the code, trace how things actually work, and answer with evidence — file paths and specifics, never guesses.

Question: %s

Work strictly read-only: do NOT create, modify, or delete any files.

Reply in EXACTLY this shape, with both tags and nothing outside them:
<note>One or two sentences for the chat: the headline of what you found or what changed.</note>
<findings>The findings document in well-structured Markdown: a one-paragraph answer first, then the supporting detail (structure, key files, gaps, options).</findings>

The <findings> document is your whole deliverable. On every follow-up turn in this conversation, reply in the same shape and re-issue the FULL updated document — never a delta or a bare answer.`, task)
		},
	}
}

// splitResearchReply separates a researcher's reply into the short chat note
// and the findings document. A reply without the expected tags becomes the
// document itself, with a stock note — the deliverable survives a model that
// forgot the shape.
func splitResearchReply(reply string) (note, findings string) {
	note = strings.TrimSpace(extractTag(reply, "note"))
	findings = strings.TrimSpace(extractTag(reply, "findings"))
	if findings == "" {
		findings = strings.TrimSpace(reply)
	}
	if note == "" {
		note = "Findings updated — open the Document tab."
	}
	return note, findings
}

func extractTag(s, tag string) string {
	open, close := "<"+tag+">", "</"+tag+">"
	start := strings.Index(s, open)
	if start == -1 {
		return ""
	}
	rest := s[start+len(open):]
	end := strings.Index(rest, close)
	if end == -1 {
		return rest
	}
	return rest[:end]
}

func (w *claudeAgentWorker) Name() string { return w.name }

func (w *claudeAgentWorker) Profile() WorkerProfile {
	capabilities := []string{
		"edit repository files via claude CLI",
		"capture changes as a unified diff for review",
	}
	if !w.capturesPatch {
		capabilities = []string{
			"read the repository via claude CLI",
			"answer with a written findings document",
		}
	}
	return WorkerProfile{
		Name:         w.name,
		Mode:         "claude-cli",
		Roles:        []string{w.role},
		Capabilities: capabilities,
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

		// A first turn gets the full engineer framing; a resumed turn sends the
		// user's message verbatim, since the framing and context already live in
		// the session being continued. Upstream hand-offs (edge data) lead the
		// first turn so the agent builds on what already landed.
		prompt := w.buildPrompt(request.MissionText)
		if request.UpstreamContext != "" {
			prompt = request.UpstreamContext + "\n\n" + prompt
		}
		if request.ResumeSessionID != "" {
			prompt = request.MissionText
		}

		// Stream Claude's reasoning (thoughts) and actions (edits, commands) into
		// the feed, tagged so the Agent transcript can render them distinctly.
		turn, err := callClaudeAgentic(ctx, request.RepoPath, request.ResumeSessionID, request.Model, request.Effort, prompt, func(kind, msg string) {
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

		// Report this turn's token accounting so the service can merge it into the
		// run's running totals (context fill + cumulative spend).
		if turn.Usage != nil {
			select {
			case <-ctx.Done():
				sendCancelledEvent(events, request.RunID)
				return
			case events <- RunEvent{Usage: turn.Usage}:
			}
		}

		// Persist the captured session so the next turn can resume this exact
		// conversation instead of starting a new one, and the model the CLI
		// actually ran so the node can show what did the work.
		if turn.SessionID != "" || turn.Model != "" {
			select {
			case <-ctx.Done():
				sendCancelledEvent(events, request.RunID)
				return
			case events <- RunEvent{SessionID: turn.SessionID, Model: turn.Model}:
			}
		}

		suggestedSubject := ""
		if strings.TrimSpace(turn.Summary) != "" {
			// A researcher's reply splits in two: a short note stays in the chat,
			// the full findings document goes to the mission via its own event.
			chatText := strings.TrimSpace(turn.Summary)
			findings := ""
			if w.deliversFindings {
				chatText, findings = splitResearchReply(turn.Summary)
			}

			// An engineer's reply ends with a <commit> tag (see buildPrompt) — pull
			// it out for the eventual git commit and keep it out of the chat text.
			if w.capturesPatch {
				if tagged := strings.TrimSpace(extractTag(chatText, "commit")); tagged != "" {
					suggestedSubject = tagged
					if idx := strings.Index(chatText, "<commit>"); idx != -1 {
						chatText = strings.TrimSpace(chatText[:idx])
					}
				}
			}

			if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "⏺ "+truncate(chatText, 200), "", "claude") {
				return
			}
			now := time.Now().UTC()
			select {
			case <-ctx.Done():
				sendCancelledEvent(events, request.RunID)
				return
			case events <- RunEvent{ChatMessage: &domain.ChatMessage{
				ID:        fmt.Sprintf("msg_%d", now.UnixNano()),
				MissionID: request.MissionID,
				RunID:     request.RunID,
				Role:      domain.ChatRoleAssistant,
				Text:      chatText,
				CreatedAt: now,
			}}:
			}

			if findings != "" {
				select {
				case <-ctx.Done():
					sendCancelledEvent(events, request.RunID)
					return
				case events <- RunEvent{Findings: findings}:
				}
			}
		}

		// A researcher's deliverable is the reply itself — no diff to capture.
		if !w.capturesPatch {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, fmt.Sprintf("Claude %s completed.", w.role), "", "")
			return
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
				ID:               fmt.Sprintf("patch_%d", now.UnixNano()),
				RunID:            request.RunID,
				Status:           domain.PatchStatusPending,
				Diff:             diff + "\n",
				SuggestedSubject: suggestedSubject,
				CreatedAt:        now,
				UpdatedAt:        now,
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
