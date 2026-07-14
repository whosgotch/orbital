package domain

import "time"

type MissionStatus string

// MissionKind separates AI tasks (an agent works toward an outcome) from tool
// steps (a deterministic command whose exit code decides pass/fail) and from
// research (a read-only agent whose deliverable is a findings document, not a
// patch). An empty kind reads as a task so state files written before the
// field existed load unchanged.
type MissionKind string

const (
	MissionKindTask     MissionKind = "task"
	MissionKindTool     MissionKind = "tool"
	MissionKindResearch MissionKind = "research"
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
	ID              string        `json:"id"`
	RepositoryID    string        `json:"repository_id"`
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
	DependsOn []string `json:"depends_on,omitempty"`
	// PlanID ties a task to the plan it was generated from, so the canvas can fan
	// a plan node out to the tasks it produced.
	PlanID string      `json:"plan_id,omitempty"`
	Kind   MissionKind `json:"kind,omitempty"`
	// ToolCommand is the shell command a kind=tool mission runs (sh -c in the
	// repo); success lands the mission as verified, failure marks it failed.
	ToolCommand string `json:"tool_command,omitempty"`
}

func (m Mission) IsTool() bool {
	return m.Kind == MissionKindTool
}

func (m Mission) IsResearch() bool {
	return m.Kind == MissionKindResearch
}
