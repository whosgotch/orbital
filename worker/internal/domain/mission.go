package domain

import "time"

type MissionStatus string

const (
	MissionStatusDraft           MissionStatus = "draft"
	MissionStatusRunning         MissionStatus = "running"
	MissionStatusWaitingApproval MissionStatus = "waiting_approval"
	MissionStatusApproved        MissionStatus = "approved"
	MissionStatusRejected        MissionStatus = "rejected"
	MissionStatusVerified        MissionStatus = "verified"
	MissionStatusFailed          MissionStatus = "failed"
)

type Mission struct {
	ID           string        `json:"id"`
	RepositoryID string        `json:"repository_id"`
	Text         string        `json:"text"`
	Status       MissionStatus `json:"status"`
	CreatedAt    time.Time     `json:"created_at"`
	UpdatedAt    time.Time     `json:"updated_at"`
}
