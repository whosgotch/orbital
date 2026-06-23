package app

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func (s *Service) MergePatches(runIDs []string) (*domain.PatchProposal, error) {
	now := time.Now().UTC()
	merged := domain.PatchProposal{
		ID:        fmt.Sprintf("patch_%d", now.UnixNano()),
		RunID:     runIDs[0],
		Status:    domain.PatchStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}

	_, err := s.store.Update(func(state *store.State) error {
		var diffs []string
		var missionID string
		for _, runID := range runIDs {
			runIndex := findRunIndex(state.AgentRuns, runID)
			if runIndex == -1 {
				continue
			}
			if missionID == "" {
				missionID = state.AgentRuns[runIndex].MissionID
			}
			for _, patch := range state.PatchProposals {
				if patch.RunID == runID && patch.Status == domain.PatchStatusPending {
					diffs = append(diffs, strings.TrimSpace(patch.Diff))
				}
			}
		}

		if len(diffs) == 0 {
			return fmt.Errorf("no pending patches found for the given runs")
		}

		merged.Diff = strings.Join(diffs, "\n")
		state.PatchProposals = append(state.PatchProposals, merged)
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			missionID, runIDs[0], domain.WorkflowEventPatchesMerged,
			fmt.Sprintf("Merged patches from %d child runs.", len(runIDs)), "", now,
		))

		if missionIndex := findMissionIndex(state.Missions, missionID); missionIndex != -1 {
			state.Missions[missionIndex].Status = domain.MissionStatusWaitingApproval
			state.Missions[missionIndex].UpdatedAt = now
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return &merged, nil
}

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
	var result domain.PatchProposal
	_, err := s.store.Update(func(state *store.State) error {
		patchIndex := findPatchIndex(state.PatchProposals, patchID)
		if patchIndex == -1 {
			return fmt.Errorf("patch proposal not found: %s", patchID)
		}

		patch := state.PatchProposals[patchIndex]
		if patch.Status != domain.PatchStatusApproved {
			return fmt.Errorf("patch proposal must be approved before applying: %s", patchID)
		}

		runIndex := findRunIndex(state.AgentRuns, patch.RunID)
		if runIndex == -1 {
			return fmt.Errorf("agent run not found: %s", patch.RunID)
		}

		missionIndex := findMissionIndex(state.Missions, state.AgentRuns[runIndex].MissionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", state.AgentRuns[runIndex].MissionID)
		}

		repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID)
		if repositoryIndex == -1 {
			return fmt.Errorf("repository not found: %s", state.Missions[missionIndex].RepositoryID)
		}

		repoPath := state.Repositories[repositoryIndex].Path
		if strings.TrimSpace(patch.Diff) != "" {
			cmd := exec.Command("git", "apply")
			cmd.Dir = repoPath
			cmd.Stdin = strings.NewReader(patch.Diff)

			output, err := cmd.CombinedOutput()
			if err != nil {
				if !patchAlreadyApplied(repoPath, patch.Diff) {
					return fmt.Errorf("apply patch: %w: %s", err, strings.TrimSpace(string(output)))
				}
			}
		}

		// The approved work has landed in the main tree; the run's isolated
		// worktree is no longer needed.
		removeRunWorktree(repoPath, state.AgentRuns[runIndex])

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

		result = state.PatchProposals[patchIndex]
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &result, nil
}

func patchAlreadyApplied(repoPath string, diff string) bool {
	cmd := exec.Command("git", "apply", "--reverse", "--check")
	cmd.Dir = repoPath
	cmd.Stdin = strings.NewReader(diff)
	return cmd.Run() == nil
}

func (s *Service) updatePatchDecision(patchID string, patchStatus domain.PatchStatus, missionStatus domain.MissionStatus, eventType domain.WorkflowEventType, message string) (*domain.PatchProposal, error) {
	var result domain.PatchProposal
	_, err := s.store.Update(func(state *store.State) error {
		patchIndex := findPatchIndex(state.PatchProposals, patchID)
		if patchIndex == -1 {
			return fmt.Errorf("patch proposal not found: %s", patchID)
		}

		if state.PatchProposals[patchIndex].Status != domain.PatchStatusPending {
			return fmt.Errorf("patch proposal must be pending before decision: %s", patchID)
		}

		runIndex := findRunIndex(state.AgentRuns, state.PatchProposals[patchIndex].RunID)
		if runIndex == -1 {
			return fmt.Errorf("agent run not found: %s", state.PatchProposals[patchIndex].RunID)
		}

		missionIndex := findMissionIndex(state.Missions, state.AgentRuns[runIndex].MissionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", state.AgentRuns[runIndex].MissionID)
		}

		// A rejected mission abandons its work, so tear down its worktree now.
		// An approved one keeps it until ApplyPatch lands the diff.
		if patchStatus == domain.PatchStatusRejected {
			if repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID); repositoryIndex != -1 {
				removeRunWorktree(state.Repositories[repositoryIndex].Path, state.AgentRuns[runIndex])
			}
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

		result = state.PatchProposals[patchIndex]
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &result, nil
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
