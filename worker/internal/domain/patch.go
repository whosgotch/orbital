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
	// CommitHash/CommitSubject are set once the patch lands as a real commit
	// (see commitApplied), so the UI can show what landed. Both stay empty when
	// applying found nothing to commit (e.g. a re-apply already matching HEAD).
	CommitHash    string `json:"commit_hash,omitempty"`
	CommitSubject string `json:"commit_subject,omitempty"`
	// Branch is the branch the commit landed on, captured at apply time.
	Branch string `json:"branch,omitempty"`
}
