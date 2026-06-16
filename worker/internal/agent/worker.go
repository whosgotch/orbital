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
}

type SupportResult struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}

type RunEvent struct {
	WorkflowEvent *domain.WorkflowEvent `json:"workflow_event,omitempty"`
	PatchProposal *domain.PatchProposal `json:"patch_proposal,omitempty"`
}

type Worker interface {
	Name() string
	Profile() WorkerProfile
	CheckAvailable(ctx context.Context) (*WorkerInfo, error)
	Supports(ctx context.Context, request RunRequest) SupportResult
	StartRun(ctx context.Context, request RunRequest) (<-chan RunEvent, error)
	CancelRun(ctx context.Context, runID string) error
}
