package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
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

// UpdateMissionText rewrites a mission's prompt — the instruction its agent will
// run — so the human can refine a planned sub-task node before launching it.
// Editing a mission that is already running is rejected to avoid changing the
// prompt out from under a live agent.
func (s *Service) UpdateMissionText(missionID string, text string) (*domain.Mission, error) {
	missionText := strings.TrimSpace(text)
	if missionText == "" {
		return nil, fmt.Errorf("mission text is required")
	}

	var updated domain.Mission
	if _, err := s.store.Update(func(state *store.State) error {
		missionIndex := findMissionIndex(state.Missions, missionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}
		if state.Missions[missionIndex].Status == domain.MissionStatusRunning {
			return fmt.Errorf("cannot edit a running mission")
		}
		state.Missions[missionIndex].Text = missionText
		state.Missions[missionIndex].UpdatedAt = time.Now().UTC()
		updated = state.Missions[missionIndex]
		return nil
	}); err != nil {
		return nil, err
	}
	return &updated, nil
}

// PlanMission decomposes a mission outcome into a set of self-written sub-tasks,
// recording each as a draft child mission (parent_mission_id set) so it renders
// as an operable node the human can run, edit, or remove. The children are not
// started — planning produces the graph, the human drives execution. If
// decomposition is unavailable, it falls back to a single sub-task carrying the
// outcome so the operation still yields one operable node.
func (s *Service) PlanMission(ctx context.Context, missionID string) ([]domain.Mission, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}
	missionIndex := findMissionIndex(state.Missions, missionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", missionID)
	}
	mission := state.Missions[missionIndex]
	repositoryIndex := findRepositoryIndex(state.Repositories, mission.RepositoryID)
	if repositoryIndex == -1 {
		return nil, fmt.Errorf("repository not found: %s", mission.RepositoryID)
	}
	repoPath := state.Repositories[repositoryIndex].Path

	planNote := ""
	tasks, err := s.decompose(ctx, repoPath, mission.Text)
	if err != nil {
		tasks = []agent.SubTask{{Title: compactTitle(mission.Text), Prompt: mission.Text}}
		planNote = fmt.Sprintf("Planning unavailable (%v); created a single sub-task.", err)
	}

	now := time.Now().UTC()
	children := make([]domain.Mission, 0, len(tasks))
	for index, task := range tasks {
		children = append(children, domain.Mission{
			ID:              fmt.Sprintf("mission_%d_%d", now.UnixNano(), index),
			RepositoryID:    mission.RepositoryID,
			Text:            task.Prompt,
			Title:           task.Title,
			Status:          domain.MissionStatusDraft,
			CreatedAt:       now,
			UpdatedAt:       now,
			ParentMissionID: missionID,
		})
	}

	if _, err := s.store.Update(func(state *store.State) error {
		if findMissionIndex(state.Missions, missionID) == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}
		state.Missions = append(state.Missions, children...)

		message := fmt.Sprintf("🧭 Planned %d sub-tasks.", len(children))
		if planNote != "" {
			message = planNote
		}
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			missionID, "", domain.WorkflowEventCommandExecuted, message, "", now,
		))
		return nil
	}); err != nil {
		return nil, err
	}

	return children, nil
}

// compactTitle reduces a mission's prose into a short node label — the first few
// words, truncated — used when no manager-written title is available.
func compactTitle(text string) string {
	words := strings.Fields(text)
	if len(words) > 6 {
		words = words[:6]
	}
	label := strings.Join(words, " ")
	if len(label) > 48 {
		label = strings.TrimSpace(label[:48]) + "…"
	}
	return label
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
