package domain

import "time"

type MissionStatus string

// MissionKind separates AI tasks (an agent works toward an outcome) from tool
// steps (a deterministic command whose exit code decides pass/fail). An empty
// kind reads as a task so state files written before the field existed load
// unchanged, and so does any kind this build no longer knows — see
// Mission.IsTool.
type MissionKind string

const (
	MissionKindTask MissionKind = "task"
	MissionKindTool MissionKind = "tool"
)

const (
	MissionStatusDraft           MissionStatus = "draft"
	MissionStatusRunning         MissionStatus = "running"
	MissionStatusWaitingApproval MissionStatus = "waiting_approval"
	MissionStatusApproved        MissionStatus = "approved"
	MissionStatusApplied         MissionStatus = "applied"
	MissionStatusRejected        MissionStatus = "rejected"
	MissionStatusVerified        MissionStatus = "verified"
	MissionStatusFailed          MissionStatus = "failed"
)

type Mission struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repository_id"`
	// Title is a short, human-scannable display name (currently only set by
	// task extraction); empty for hand-typed missions, where the frontend
	// derives a display label from Text itself.
	Title           string        `json:"title,omitempty"`
	Text            string        `json:"text"`
	Status          MissionStatus `json:"status"`
	CreatedAt       time.Time     `json:"created_at"`
	UpdatedAt       time.Time     `json:"updated_at"`
	ParentMissionID string        `json:"parent_mission_id,omitempty"`
	// CampaignID groups the per-repo missions of one coordinated multi-repo
	// change. Each repo keeps its own state file, so a campaign is reconstructed
	// by grouping missions that share this id across the combined workspace.
	CampaignID string `json:"campaign_id,omitempty"`
	// DependsOn lists upstream missions in the same repo whose patches must land
	// before this mission's agent starts — a task→task edge on the canvas.
	DependsOn []string    `json:"depends_on,omitempty"`
	Kind      MissionKind `json:"kind,omitempty"`
	// ToolCommand is the shell command a kind=tool mission runs (sh -c in the
	// repo); success lands the mission as verified, failure marks it failed.
	ToolCommand string `json:"tool_command,omitempty"`
	// Model is the claude model chosen for this mission when it was created.
	// It is the decision, persisted: a run started later uses it unless the
	// caller names a different one, so a reload cannot silently swap the model
	// out from under a task the user already made a choice for.
	Model string `json:"model,omitempty"`
}

// IsTool is the only kind test there is: tool missions run a command, and
// everything else — including the retired "research" kind still sitting in
// older state files — runs as an ordinary task.
func (m Mission) IsTool() bool {
	return m.Kind == MissionKindTool
}
