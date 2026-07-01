package domain

import "time"

type AgentRunStatus string

const (
	AgentRunStatusQueued             AgentRunStatus = "queued"
	AgentRunStatusRunning            AgentRunStatus = "running"
	AgentRunStatusWaitingForChildren AgentRunStatus = "waiting_for_children"
	AgentRunStatusAggregating        AgentRunStatus = "aggregating"
	AgentRunStatusCompleted          AgentRunStatus = "completed"
	AgentRunStatusFailed             AgentRunStatus = "failed"
	AgentRunStatusCancelled          AgentRunStatus = "cancelled"
)

type AgentRun struct {
	ID          string         `json:"id"`
	MissionID   string         `json:"mission_id"`
	WorkerName  string         `json:"worker_name"`
	Status      AgentRunStatus `json:"status"`
	StartedAt   time.Time      `json:"started_at"`
	CompletedAt *time.Time     `json:"completed_at,omitempty"`
	Error       string         `json:"error,omitempty"`
	ParentRunID string         `json:"parent_run_id,omitempty"`
	ChildRunIDs []string       `json:"child_run_ids,omitempty"`
	// WorktreePath is the isolated git worktree this run works in, so parallel
	// runs on the same repo don't collide. Empty when the run uses the repo root.
	WorktreePath string `json:"worktree_path,omitempty"`
	// SessionID is the claude CLI session this run owns, captured on its first
	// turn. A later chat turn resumes it (`claude --resume`), so the agent keeps
	// its context across messages instead of starting fresh each time.
	SessionID string `json:"session_id,omitempty"`
}
