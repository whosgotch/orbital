package app

import (
	"fmt"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// CreateMission records a draft mission for a repo. A non-empty campaignID ties
// it to a coordinated multi-repo change so the campaign can be reconstructed by
// grouping missions that share the id across each repo's separate state.
func (s *Service) CreateMission(repoID string, text string, campaignID string) (*domain.Mission, error) {
	missionText := strings.TrimSpace(text)
	if missionText == "" {
		return nil, fmt.Errorf("mission text is required")
	}

	now := time.Now().UTC()
	mission := domain.Mission{
		ID:           fmt.Sprintf("mission_%d", now.UnixNano()),
		RepositoryID: repoID,
		Text:         missionText,
		Status:       domain.MissionStatusDraft,
		CreatedAt:    now,
		UpdatedAt:    now,
		CampaignID:   strings.TrimSpace(campaignID),
	}

	_, err := s.store.Update(func(state *store.State) error {
		repositoryExists := false
		for _, repository := range state.Repositories {
			if repository.ID == repoID {
				repositoryExists = true
				break
			}
		}

		if !repositoryExists {
			return fmt.Errorf("repository not found: %s", repoID)
		}

		state.Missions = append(state.Missions, mission)
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &mission, nil
}

// DeleteMission removes a mission and everything attached to it — its agent
// runs, their patches, the mission's verification runs and workflow events —
// then cleans up any per-run git worktrees the runs left behind.
func (s *Service) DeleteMission(missionID string) error {
	var worktreeCleanup []domain.AgentRun
	repoPath := ""

	_, err := s.store.Update(func(state *store.State) error {
		missionIndex := -1
		for index, mission := range state.Missions {
			if mission.ID == missionID {
				missionIndex = index
				break
			}
		}
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}

		if repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID); repositoryIndex != -1 {
			repoPath = state.Repositories[repositoryIndex].Path
		}

		runIDs := map[string]bool{}
		remainingRuns := make([]domain.AgentRun, 0, len(state.AgentRuns))
		for _, run := range state.AgentRuns {
			if run.MissionID == missionID {
				runIDs[run.ID] = true
				worktreeCleanup = append(worktreeCleanup, run)
			} else {
				remainingRuns = append(remainingRuns, run)
			}
		}
		state.AgentRuns = remainingRuns

		remainingPatches := make([]domain.PatchProposal, 0, len(state.PatchProposals))
		for _, patch := range state.PatchProposals {
			if !runIDs[patch.RunID] {
				remainingPatches = append(remainingPatches, patch)
			}
		}
		state.PatchProposals = remainingPatches

		remainingVerifications := make([]domain.VerificationRun, 0, len(state.VerificationRuns))
		for _, verification := range state.VerificationRuns {
			if verification.MissionID != missionID {
				remainingVerifications = append(remainingVerifications, verification)
			}
		}
		state.VerificationRuns = remainingVerifications

		remainingEvents := make([]domain.WorkflowEvent, 0, len(state.WorkflowEvents))
		for _, event := range state.WorkflowEvents {
			if event.MissionID != missionID && !runIDs[event.RunID] {
				remainingEvents = append(remainingEvents, event)
			}
		}
		state.WorkflowEvents = remainingEvents

		state.Missions = append(state.Missions[:missionIndex], state.Missions[missionIndex+1:]...)
		return nil
	})
	if err != nil {
		return err
	}

	for _, run := range worktreeCleanup {
		if run.WorktreePath != "" && repoPath != "" {
			removeRunWorktree(repoPath, run)
		}
	}
	return nil
}
