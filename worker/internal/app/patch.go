package app

import (
	"fmt"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func (s *Service) ApprovePatch(patchID string) (*domain.PatchProposal, error) {
	return s.updatePatchDecision(patchID, domain.PatchStatusApproved, domain.MissionStatusApproved)
}

func (s *Service) RejectPatch(patchID string) (*domain.PatchProposal, error) {
	return s.updatePatchDecision(patchID, domain.PatchStatusRejected, domain.MissionStatusRejected)
}

func (s *Service) updatePatchDecision(patchID string, patchStatus domain.PatchStatus, missionStatus domain.MissionStatus) (*domain.PatchProposal, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	patchIndex := findPatchIndex(state.PatchProposals, patchID)
	if patchIndex == -1 {
		return nil, fmt.Errorf("patch proposal not found: %s", patchID)
	}

	runIndex := findRunIndex(state.AgentRuns, state.PatchProposals[patchIndex].RunID)
	if runIndex == -1 {
		return nil, fmt.Errorf("agent run not found: %s", state.PatchProposals[patchIndex].RunID)
	}

	missionIndex := findMissionIndex(state.Missions, state.AgentRuns[runIndex].MissionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", state.AgentRuns[runIndex].MissionID)
	}

	now := time.Now().UTC()
	state.PatchProposals[patchIndex].Status = patchStatus
	state.PatchProposals[patchIndex].UpdatedAt = now
	state.Missions[missionIndex].Status = missionStatus
	state.Missions[missionIndex].UpdatedAt = now

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	return &state.PatchProposals[patchIndex], nil
}

func findPatchIndex(patches []domain.PatchProposal, patchID string) int {
	for index, patch := range patches {
		if patch.ID == patchID {
			return index
		}
	}

	return -1
}

func findRunIndex(runs []domain.AgentRun, runID string) int {
	for index, run := range runs {
		if run.ID == runID {
			return index
		}
	}

	return -1
}
