package agent

import (
	"context"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

type WorkerInfo struct {
	Name      string        `json:"name"`
	Available bool          `json:"available"`
	Reason    string        `json:"reason,omitempty"`
	Profile   WorkerProfile `json:"profile"`
}

type WorkerProfile struct {
	Name         string   `json:"name"`
	Mode         string   `json:"mode"`
	Roles        []string `json:"roles"`
	Capabilities []string `json:"capabilities"`
	Limitations  []string `json:"limitations"`
}

type RunRequest struct {
	RunID       string `json:"run_id"`
	MissionID   string `json:"mission_id"`
	RepoPath    string `json:"repo_path"`
	MissionText string `json:"mission_text"`
	// ResumeSessionID, when set, continues an existing claude chat session instead
	// of starting a fresh one — so MissionText is treated as the next message in an
	// ongoing conversation rather than a standalone task.
	ResumeSessionID string `json:"resume_session_id,omitempty"`
	// Model, when set, is passed to the claude CLI as --model (an alias like
	// "opus"/"sonnet"/"haiku" or a full model id). Empty means the CLI default.
	Model string `json:"model,omitempty"`
	// UpstreamContext carries the work products of the missions this mission
	// depends on (task text, final summary, landed diff) — the data that flows
	// along a drawn task→task edge. Empty when the mission has no upstreams.
	UpstreamContext string `json:"upstream_context,omitempty"`
}

type SupportResult struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}

type RunEvent struct {
	WorkflowEvent *domain.WorkflowEvent `json:"workflow_event,omitempty"`
	PatchProposal *domain.PatchProposal `json:"patch_proposal,omitempty"`
	// ChatMessage carries the agent's reply for a chat turn, recorded as an
	// assistant message in the conversation.
	ChatMessage *domain.ChatMessage `json:"chat_message,omitempty"`
	// SessionID is the claude session this run captured, so the service can
	// persist it onto the run and resume the same conversation next turn.
	SessionID string `json:"session_id,omitempty"`
}

type Worker interface {
	Name() string
	Profile() WorkerProfile
	CheckAvailable(ctx context.Context) (*WorkerInfo, error)
	Supports(ctx context.Context, request RunRequest) SupportResult
	StartRun(ctx context.Context, request RunRequest) (<-chan RunEvent, error)
	CancelRun(ctx context.Context, runID string) error
}
