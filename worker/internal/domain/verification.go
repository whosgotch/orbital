package domain

import "time"

type VerificationStatus string

const (
	VerificationStatusQueued  VerificationStatus = "queued"
	VerificationStatusRunning VerificationStatus = "running"
	VerificationStatusPassed  VerificationStatus = "passed"
	VerificationStatusFailed  VerificationStatus = "failed"
)

type VerificationRun struct {
	ID           string             `json:"id"`
	MissionID    string             `json:"mission_id"`
	RepositoryID string             `json:"repository_id"`
	Command      string             `json:"command"`
	Status       VerificationStatus `json:"status"`
	ExitCode     *int               `json:"exit_code,omitempty"`
	Output       string             `json:"output"`
	StartedAt    time.Time          `json:"started_at"`
	CompletedAt  *time.Time         `json:"completed_at,omitempty"`
}
