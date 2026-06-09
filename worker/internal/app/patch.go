package app

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func (s *Service) ApprovePatch(patchID string) (*domain.PatchProposal, error) {
	return s.updatePatchDecision(
		patchID,
		domain.PatchStatusApproved,
		domain.MissionStatusApproved,
		domain.WorkflowEventPatchApproved,
		"Patch approved.",
	)
}

func (s *Service) RejectPatch(patchID string) (*domain.PatchProposal, error) {
	return s.updatePatchDecision(
		patchID,
		domain.PatchStatusRejected,
		domain.MissionStatusRejected,
		domain.WorkflowEventPatchRejected,
		"Patch rejected.",
	)
}

func (s *Service) ApplyPatch(patchID string) (*domain.PatchProposal, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	patchIndex := findPatchIndex(state.PatchProposals, patchID)
	if patchIndex == -1 {
		return nil, fmt.Errorf("patch proposal not found: %s", patchID)
	}

	patch := state.PatchProposals[patchIndex]
	if patch.Status != domain.PatchStatusApproved {
		return nil, fmt.Errorf("patch proposal must be approved before applying: %s", patchID)
	}

	runIndex := findRunIndex(state.AgentRuns, patch.RunID)
	if runIndex == -1 {
		return nil, fmt.Errorf("agent run not found: %s", patch.RunID)
	}

	missionIndex := findMissionIndex(state.Missions, state.AgentRuns[runIndex].MissionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", state.AgentRuns[runIndex].MissionID)
	}

	repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID)
	if repositoryIndex == -1 {
		return nil, fmt.Errorf("repository not found: %s", state.Missions[missionIndex].RepositoryID)
	}

	cmd := exec.Command("git", "apply")
	cmd.Dir = state.Repositories[repositoryIndex].Path
	cmd.Stdin = strings.NewReader(patch.Diff)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("apply patch: %w: %s", err, strings.TrimSpace(string(output)))
	}

	now := time.Now().UTC()
	state.PatchProposals[patchIndex].Status = domain.PatchStatusApplied
	state.PatchProposals[patchIndex].UpdatedAt = now
	state.Missions[missionIndex].Status = domain.MissionStatusApplied
	state.Missions[missionIndex].UpdatedAt = now
	state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
		state.Missions[missionIndex].ID,
		patch.RunID,
		domain.WorkflowEventPatchApplied,
		"Patch applied.",
		"",
		now,
	))

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	return &state.PatchProposals[patchIndex], nil
}

func (s *Service) updatePatchDecision(patchID string, patchStatus domain.PatchStatus, missionStatus domain.MissionStatus, eventType domain.WorkflowEventType, message string) (*domain.PatchProposal, error) {
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
	state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
		state.Missions[missionIndex].ID,
		state.AgentRuns[runIndex].ID,
		eventType,
		message,
		"",
		now,
	))

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
