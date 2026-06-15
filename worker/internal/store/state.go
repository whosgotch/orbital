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

func (s *State) Normalize() {
	if s.Repositories == nil {
		s.Repositories = []domain.Repository{}
	}
	if s.Missions == nil {
		s.Missions = []domain.Mission{}
	}
	if s.AgentRuns == nil {
		s.AgentRuns = []domain.AgentRun{}
	}
	if s.WorkflowEvents == nil {
		s.WorkflowEvents = []domain.WorkflowEvent{}
	}
	if s.PatchProposals == nil {
		s.PatchProposals = []domain.PatchProposal{}
	}
	if s.VerificationRuns == nil {
		s.VerificationRuns = []domain.VerificationRun{}
	}
}
