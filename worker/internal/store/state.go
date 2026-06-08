package store

import "github.com/whosgotch/orbital/worker/internal/domain"

type State struct {
	Repositories     []domain.Repository      `json:"repositories"`
	Missions         []domain.Mission         `json:"missions"`
	AgentRuns        []domain.AgentRun        `json:"agent_runs"`
	WorkflowEvents   []domain.WorkflowEvent   `json:"workflow_events"`
	PatchProposals   []domain.PatchProposal   `json:"patch_proposals"`
	VerificationRuns []domain.VerificationRun `json:"verification_runs"`
}
