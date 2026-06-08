package domain

import "time"

type PatchStatus string

const (
	PatchStatusPending  PatchStatus = "pending"
	PatchStatusApproved PatchStatus = "approved"
	PatchStatusRejected PatchStatus = "rejected"
	PatchStatusApplied  PatchStatus = "applied"
)

type PatchProposal struct {
	ID        string      `json:"id"`
	RunID     string      `json:"run_id"`
	Status    PatchStatus `json:"status"`
	Diff      string      `json:"diff"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}
