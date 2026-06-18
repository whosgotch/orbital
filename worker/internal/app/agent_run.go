package app

import (
	"context"
	"encoding/json"
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

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	runRequest := agent.RunRequest{
		RunID:       run.ID,
		MissionID:   mission.ID,
		RepoPath:    state.Repositories[repositoryIndex].Path,
		MissionText: mission.Text,
	}

	if support := worker.Supports(ctx, runRequest); !support.Supported {
		if err := s.saveRunEvent(missionID, agent.RunEvent{
			WorkflowEvent: &domain.WorkflowEvent{
				ID:        fmt.Sprintf("event_%d", time.Now().UTC().UnixNano()),
				RunID:     run.ID,
				Type:      domain.WorkflowEventRunFailed,
				Message:   support.Reason,
				CreatedAt: time.Now().UTC(),
			},
		}); err != nil {
			return nil, err
		}

		return s.finishAgentRun(run.ID, missionID)
	}

	events, err := worker.StartRun(ctx, runRequest)
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
		if err := s.saveRunEvent(missionID, event); err != nil {
			return nil, err
		}
	}

	return s.finishAgentRun(run.ID, missionID)
}

func (s *Service) finishAgentRun(runID string, missionID string) (*domain.AgentRun, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	runIndex := findRunIndex(state.AgentRuns, runID)
	if runIndex == -1 {
		return nil, fmt.Errorf("agent run not found: %s", runID)
	}

	missionIndex := findMissionIndex(state.Missions, missionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", missionID)
	}

	completedAt := time.Now().UTC()
	finalStatus := finalRunStatus(state.WorkflowEvents, runID)
	state.AgentRuns[runIndex].Status = finalStatus
	state.AgentRuns[runIndex].CompletedAt = &completedAt
	if finalStatus == domain.AgentRunStatusFailed || finalStatus == domain.AgentRunStatusCancelled {
		state.Missions[missionIndex].Status = domain.MissionStatusFailed
		state.Missions[missionIndex].UpdatedAt = completedAt
	}

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	return &state.AgentRuns[runIndex], nil
}

func (s *Service) saveRunEvent(missionID string, event agent.RunEvent) error {
	state, err := s.store.Load()
	if err != nil {
		return err
	}

	missionIndex := findMissionIndex(state.Missions, missionID)
	if missionIndex == -1 {
		return fmt.Errorf("mission not found: %s", missionID)
	}

	if event.WorkflowEvent != nil {
		event.WorkflowEvent.MissionID = missionID
		state.WorkflowEvents = append(state.WorkflowEvents, *event.WorkflowEvent)
	}

	if event.PatchProposal != nil {
		state.PatchProposals = append(state.PatchProposals, *event.PatchProposal)
		state.Missions[missionIndex].Status = domain.MissionStatusWaitingApproval
		state.Missions[missionIndex].UpdatedAt = event.PatchProposal.UpdatedAt
	}

	if err := s.store.Save(state); err != nil {
		return err
	}

	s.streamRunEvent(event)
	return nil
}

func (s *Service) SpawnChildRun(ctx context.Context, parentRunID string, workerName string, task string) (*domain.AgentRun, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	parentIndex := findRunIndex(state.AgentRuns, parentRunID)
	if parentIndex == -1 {
		return nil, fmt.Errorf("parent run not found: %s", parentRunID)
	}

	parentRun := state.AgentRuns[parentIndex]
	missionIndex := findMissionIndex(state.Missions, parentRun.MissionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", parentRun.MissionID)
	}

	repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID)
	if repositoryIndex == -1 {
		return nil, fmt.Errorf("repository not found: %s", state.Missions[missionIndex].RepositoryID)
	}

	worker, err := s.workerRegistry.Lookup(workerName)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	childRun := domain.AgentRun{
		ID:          fmt.Sprintf("run_%d", now.UnixNano()),
		MissionID:   parentRun.MissionID,
		WorkerName:  workerName,
		Status:      domain.AgentRunStatusRunning,
		StartedAt:   now,
		ParentRunID: parentRunID,
	}

	state.AgentRuns[parentIndex].ChildRunIDs = append(state.AgentRuns[parentIndex].ChildRunIDs, childRun.ID)
	state.AgentRuns[parentIndex].Status = domain.AgentRunStatusWaitingForChildren
	state.AgentRuns = append(state.AgentRuns, childRun)
	state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
		parentRun.MissionID, parentRunID, domain.WorkflowEventChildRunSpawned,
		fmt.Sprintf("Manager spawned %s agent.", workerName), "", now,
	))

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	missionText := state.Missions[missionIndex].Text
	if task != "" {
		missionText = task
	}
	runRequest := agent.RunRequest{
		RunID:       childRun.ID,
		MissionID:   parentRun.MissionID,
		RepoPath:    state.Repositories[repositoryIndex].Path,
		MissionText: missionText,
	}

	events, err := worker.StartRun(ctx, runRequest)
	if err != nil {
		return nil, err
	}

	for event := range events {
		if err := s.saveRunEvent(parentRun.MissionID, event); err != nil {
			return nil, err
		}
	}

	return s.finishAgentRun(childRun.ID, parentRun.MissionID)
}

func (s *Service) streamRunEvent(event agent.RunEvent) {
	if s.eventOut == nil {
		return
	}
	var prefix string
	var data []byte
	var err error
	if event.WorkflowEvent != nil {
		prefix = "EVENT:"
		data, err = json.Marshal(event.WorkflowEvent)
	} else if event.PatchProposal != nil {
		prefix = "PATCH:"
		data, err = json.Marshal(event.PatchProposal)
	}
	if err != nil || data == nil {
		return
	}
	fmt.Fprintf(s.eventOut, "%s%s\n", prefix, data)
}

func finalRunStatus(events []domain.WorkflowEvent, runID string) domain.AgentRunStatus {
	status := domain.AgentRunStatusCompleted
	for _, event := range events {
		if event.RunID != runID {
			continue
		}

		switch event.Type {
		case domain.WorkflowEventRunFailed:
			status = domain.AgentRunStatusFailed
		case domain.WorkflowEventRunCancelled:
			status = domain.AgentRunStatusCancelled
		}
	}

	return status
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
