package domain

import "time"

type MissionStatus string

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
	ID             string        `json:"id"`
	RepositoryID   string        `json:"repository_id"`
	Text           string        `json:"text"`
	Status         MissionStatus `json:"status"`
	CreatedAt      time.Time     `json:"created_at"`
	UpdatedAt      time.Time     `json:"updated_at"`
	ParentMissionID string       `json:"parent_mission_id,omitempty"`
	// CampaignID groups the per-repo missions of one coordinated multi-repo
	// change. Each repo keeps its own state file, so a campaign is reconstructed
	// by grouping missions that share this id across the combined workspace.
	CampaignID string `json:"campaign_id,omitempty"`
}
