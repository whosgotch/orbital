package app

import (
	"context"
	"fmt"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
)

func (s *Service) StartAgentRun(ctx context.Context, missionID string, workerName string) (*domain.AgentRun, error) {
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

	worker, err := s.workerRegistry.Lookup(workerName)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	run := domain.AgentRun{
		ID:         fmt.Sprintf("run_%d", now.UnixNano()),
		MissionID:  missionID,
		WorkerName: workerName,
		Status:     domain.AgentRunStatusRunning,
		StartedAt:  now,
	}

	state.AgentRuns = append(state.AgentRuns, run)
	state.Missions[missionIndex].Status = domain.MissionStatusRunning
	state.Missions[missionIndex].UpdatedAt = now

	events, err := worker.StartRun(ctx, agent.RunRequest{
		RunID:       run.ID,
		MissionID:   mission.ID,
		RepoPath:    state.Repositories[repositoryIndex].Path,
		MissionText: mission.Text,
	})
	if err != nil {
		failedAt := time.Now().UTC()
		run.Status = domain.AgentRunStatusFailed
		run.CompletedAt = &failedAt
		run.Error = err.Error()
		state.AgentRuns[len(state.AgentRuns)-1] = run
		state.Missions[missionIndex].Status = domain.MissionStatusFailed
		state.Missions[missionIndex].UpdatedAt = failedAt

		if saveErr := s.store.Save(state); saveErr != nil {
			return nil, saveErr
		}

		return &run, err
	}

	for event := range events {
		if event.WorkflowEvent != nil {
			state.WorkflowEvents = append(state.WorkflowEvents, *event.WorkflowEvent)
		}

		if event.PatchProposal != nil {
			state.PatchProposals = append(state.PatchProposals, *event.PatchProposal)
			state.Missions[missionIndex].Status = domain.MissionStatusWaitingApproval
			state.Missions[missionIndex].UpdatedAt = event.PatchProposal.UpdatedAt
		}
	}

	completedAt := time.Now().UTC()
	run.Status = domain.AgentRunStatusCompleted
	run.CompletedAt = &completedAt
	state.AgentRuns[len(state.AgentRuns)-1] = run

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	return &run, nil
}

func findMissionIndex(missions []domain.Mission, missionID string) int {
	for index, mission := range missions {
		if mission.ID == missionID {
			return index
		}
	}

	return -1
}

func findRepositoryIndex(repositories []domain.Repository, repositoryID string) int {
	for index, repository := range repositories {
		if repository.ID == repositoryID {
			return index
		}
	}

	return -1
}
