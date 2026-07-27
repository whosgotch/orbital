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
	// DurationMs is how long the run took, in milliseconds — captured from
	// StartedAt to CompletedAt when the run finishes. Zero while still running.
	DurationMs int64 `json:"duration_ms,omitempty"`
	Error       string   `json:"error,omitempty"`
	ParentRunID string   `json:"parent_run_id,omitempty"`
	ChildRunIDs []string `json:"child_run_ids,omitempty"`
	// WorktreePath is the isolated git worktree this run works in, so parallel
	// runs on the same repo don't collide. Empty when the run uses the repo root.
	WorktreePath string `json:"worktree_path,omitempty"`
	// SessionID is the claude CLI session this run owns, captured on its first
	// turn. A later chat turn resumes it (`claude --resume`), so the agent keeps
	// its context across messages instead of starting fresh each time.
	SessionID string `json:"session_id,omitempty"`
	// Usage is the token accounting for this run, distilled from the Claude CLI's
	// stream-json usage records. Nil until the run's first turn reports usage.
	Usage *RunUsage `json:"usage,omitempty"`
}

// RunUsage is a run's token accounting. ContextTokens is the live
// context-window fill — the full input (cache included) of the run's most
// recent turn, i.e. how much of the model's window is currently occupied. The
// remaining fields accumulate across every turn the run's session has taken, so
// they answer "how much has this agent burned in total".
type RunUsage struct {
	ContextTokens int     `json:"context_tokens"`
	InputTokens   int     `json:"input_tokens"`
	OutputTokens  int     `json:"output_tokens"`
	TotalTokens   int     `json:"total_tokens"`
	CostUSD       float64 `json:"cost_usd,omitempty"`
}

// Merge folds one turn's usage into the run's running totals: the input/output/
// total/cost figures accumulate, while ContextTokens is replaced by the turn's
// value (the current fill, not a sum). A nil turn leaves the receiver unchanged;
// merging into a nil receiver returns a copy of the turn.
func (u *RunUsage) Merge(turn *RunUsage) *RunUsage {
	if turn == nil {
		return u
	}
	if u == nil {
		cp := *turn
		return &cp
	}
	merged := *u
	merged.InputTokens += turn.InputTokens
	merged.OutputTokens += turn.OutputTokens
	merged.TotalTokens += turn.TotalTokens
	merged.CostUSD += turn.CostUSD
	if turn.ContextTokens > 0 {
		merged.ContextTokens = turn.ContextTokens
	}
	return &merged
}
