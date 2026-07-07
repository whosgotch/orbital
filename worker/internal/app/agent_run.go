package app

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func (s *Service) StartAgentRun(ctx context.Context, missionID string, workerName string) (*domain.AgentRun, error) {
	// A tool mission always runs its own stored command; the caller's worker
	// choice is irrelevant, so auto-dispatched chains never need to thread it.
	worker, workerName, err := s.resolveWorker(missionID, workerName)
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

	// Record the run and mark the mission running. Capture the repo path and
	// mission text so the rest of the run works without holding the lock.
	// (resolveWorker's read and this write are separate transactions, but a
	// mission's kind and tool command never change after creation.)
	var repoPath, missionText string
	if _, err := s.store.Update(func(state *store.State) error {
		missionIndex := findMissionIndex(state.Missions, missionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}

		repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID)
		if repositoryIndex == -1 {
			return fmt.Errorf("repository not found: %s", state.Missions[missionIndex].RepositoryID)
		}

		repoPath = state.Repositories[repositoryIndex].Path
		missionText = state.Missions[missionIndex].Text
		state.AgentRuns = append(state.AgentRuns, run)
		state.Missions[missionIndex].Status = domain.MissionStatusRunning
		state.Missions[missionIndex].UpdatedAt = now
		return nil
	}); err != nil {
		return nil, err
	}

	s.streamAgentRun(run)

	// Give this mission its own git worktree so it can run alongside others
	// without sharing a working tree. Fall back to the repo root if the repo
	// can't host a worktree.
	workdir := repoPath
	if worktreePath := createRunWorktree(ctx, repoPath, run.ID); worktreePath != "" {
		workdir = worktreePath
		run.WorktreePath = worktreePath
		if _, err := s.store.Update(func(state *store.State) error {
			if runIndex := findRunIndex(state.AgentRuns, run.ID); runIndex != -1 {
				state.AgentRuns[runIndex].WorktreePath = worktreePath
			}
			return nil
		}); err != nil {
			return nil, err
		}
	}

	runRequest := agent.RunRequest{
		RunID:       run.ID,
		MissionID:   missionID,
		RepoPath:    workdir,
		MissionText: missionText,
		Model:       s.runModel,
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

		removeRunWorktree(repoPath, run)
		return s.finishAgentRun(run.ID, missionID)
	}

	events, err := worker.StartRun(ctx, runRequest)
	if err != nil {
		failedAt := time.Now().UTC()
		run.Status = domain.AgentRunStatusFailed
		run.CompletedAt = &failedAt
		run.Error = err.Error()

		if _, saveErr := s.store.Update(func(state *store.State) error {
			if runIndex := findRunIndex(state.AgentRuns, run.ID); runIndex != -1 {
				state.AgentRuns[runIndex] = run
			}
			if missionIndex := findMissionIndex(state.Missions, missionID); missionIndex != -1 {
				state.Missions[missionIndex].Status = domain.MissionStatusFailed
				state.Missions[missionIndex].UpdatedAt = failedAt
			}
			return nil
		}); saveErr != nil {
			return nil, saveErr
		}

		removeRunWorktree(repoPath, run)
		s.streamAgentRun(run)
		return &run, err
	}

	for event := range events {
		if err := s.saveRunEvent(missionID, event); err != nil {
			return nil, err
		}
	}

	return s.finishAgentRun(run.ID, missionID)
}

func (s *Service) resolveWorker(missionID string, workerName string) (agent.Worker, string, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, "", err
	}

	missionIndex := findMissionIndex(state.Missions, missionID)
	if missionIndex == -1 {
		return nil, "", fmt.Errorf("mission not found: %s", missionID)
	}

	if mission := state.Missions[missionIndex]; mission.IsTool() {
		toolWorker := agent.NewLocalCommandWorker(mission.ToolCommand)
		return toolWorker, toolWorker.Name(), nil
	}

	worker, err := s.workerRegistry.Lookup(workerName)
	if err != nil {
		return nil, "", err
	}

	return worker, workerName, nil
}

func (s *Service) finishAgentRun(runID string, missionID string) (*domain.AgentRun, error) {
	var result domain.AgentRun
	_, err := s.store.Update(func(state *store.State) error {
		runIndex := findRunIndex(state.AgentRuns, runID)
		if runIndex == -1 {
			return fmt.Errorf("agent run not found: %s", runID)
		}

		missionIndex := findMissionIndex(state.Missions, missionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}

		completedAt := time.Now().UTC()
		finalStatus := finalRunStatus(state.WorkflowEvents, runID)
		state.AgentRuns[runIndex].Status = finalStatus
		state.AgentRuns[runIndex].CompletedAt = &completedAt
		if finalStatus == domain.AgentRunStatusFailed || finalStatus == domain.AgentRunStatusCancelled {
			state.Missions[missionIndex].Status = domain.MissionStatusFailed
			state.Missions[missionIndex].UpdatedAt = completedAt
		}

		// A tool step has no patch gate: its command finishing cleanly IS the
		// outcome, so land the mission as verified to release chained tasks.
		// A tool that did emit a patch artifact is in waiting_approval by now
		// and keeps the normal approve gate.
		mission := state.Missions[missionIndex]
		if mission.IsTool() && finalStatus == domain.AgentRunStatusCompleted && mission.Status == domain.MissionStatusRunning {
			state.Missions[missionIndex].Status = domain.MissionStatusVerified
			state.Missions[missionIndex].UpdatedAt = completedAt
		}

		result = state.AgentRuns[runIndex]
		return nil
	})
	if err != nil {
		return nil, err
	}

	s.streamAgentRun(result)
	return &result, nil
}

func (s *Service) saveRunEvent(missionID string, event agent.RunEvent) error {
	_, err := s.store.Update(func(state *store.State) error {
		missionIndex := findMissionIndex(state.Missions, missionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}

		if event.WorkflowEvent != nil {
			event.WorkflowEvent.MissionID = missionID
			state.WorkflowEvents = append(state.WorkflowEvents, *event.WorkflowEvent)
		}

		if event.PatchProposal != nil {
			// A chat agent proposes a fresh patch every turn; keep only the latest
			// pending one per run so the gate never sees a stale, superseded diff.
			pruned := state.PatchProposals[:0]
			for _, patch := range state.PatchProposals {
				if patch.RunID == event.PatchProposal.RunID && patch.Status == domain.PatchStatusPending {
					continue
				}
				pruned = append(pruned, patch)
			}
			state.PatchProposals = append(pruned, *event.PatchProposal)
			state.Missions[missionIndex].Status = domain.MissionStatusWaitingApproval
			state.Missions[missionIndex].UpdatedAt = event.PatchProposal.UpdatedAt
		}

		if event.ChatMessage != nil {
			state.ChatMessages = append(state.ChatMessages, *event.ChatMessage)
		}

		return nil
	})
	if err != nil {
		return err
	}

	s.streamRunEvent(event)
	return nil
}

func (s *Service) SpawnChildRun(ctx context.Context, parentRunID string, workerName string, task string) (*domain.AgentRun, error) {
	worker, err := s.workerRegistry.Lookup(workerName)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	childRun := domain.AgentRun{
		ID:          fmt.Sprintf("run_%d", now.UnixNano()),
		WorkerName:  workerName,
		Status:      domain.AgentRunStatusRunning,
		StartedAt:   now,
		ParentRunID: parentRunID,
	}

	// Each child gets its own isolated worktree (created below), so the agents an
	// AI manager spawns for independent parts can run in parallel without sharing
	// a working tree.
	var missionID, workdir, missionText, repoPath string
	var spawnEvent domain.WorkflowEvent
	if _, err := s.store.Update(func(state *store.State) error {
		parentIndex := findRunIndex(state.AgentRuns, parentRunID)
		if parentIndex == -1 {
			return fmt.Errorf("parent run not found: %s", parentRunID)
		}

		parentRun := state.AgentRuns[parentIndex]
		missionID = parentRun.MissionID
		missionIndex := findMissionIndex(state.Missions, missionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}

		repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID)
		if repositoryIndex == -1 {
			return fmt.Errorf("repository not found: %s", state.Missions[missionIndex].RepositoryID)
		}

		repoPath = state.Repositories[repositoryIndex].Path
		workdir = repoPath
		missionText = state.Missions[missionIndex].Text
		if task != "" {
			missionText = task
		}

		childRun.MissionID = missionID
		state.AgentRuns[parentIndex].ChildRunIDs = append(state.AgentRuns[parentIndex].ChildRunIDs, childRun.ID)
		state.AgentRuns[parentIndex].Status = domain.AgentRunStatusWaitingForChildren
		state.AgentRuns = append(state.AgentRuns, childRun)
		spawnEvent = newWorkflowEvent(
			missionID, parentRunID, domain.WorkflowEventChildRunSpawned,
			fmt.Sprintf("Manager spawned %s agent.", workerName), "", now,
		)
		state.WorkflowEvents = append(state.WorkflowEvents, spawnEvent)
		return nil
	}); err != nil {
		return nil, err
	}

	s.streamAgentRun(childRun)
	s.streamRunEvent(agent.RunEvent{WorkflowEvent: &spawnEvent})

	// `git worktree add` isn't safe to race, so serialize creation; the agents
	// then run in parallel in their separate trees. Fall back to the repo root.
	s.worktreeMu.Lock()
	worktreePath := createRunWorktree(ctx, repoPath, childRun.ID)
	s.worktreeMu.Unlock()
	if worktreePath != "" {
		workdir = worktreePath
		childRun.WorktreePath = worktreePath
		if _, err := s.store.Update(func(state *store.State) error {
			if runIndex := findRunIndex(state.AgentRuns, childRun.ID); runIndex != -1 {
				state.AgentRuns[runIndex].WorktreePath = worktreePath
			}
			return nil
		}); err != nil {
			return nil, err
		}
	}

	runRequest := agent.RunRequest{
		RunID:       childRun.ID,
		MissionID:   missionID,
		RepoPath:    workdir,
		MissionText: missionText,
		Model:       s.runModel,
	}

	events, err := worker.StartRun(ctx, runRequest)
	if err != nil {
		return nil, err
	}

	for event := range events {
		if err := s.saveRunEvent(missionID, event); err != nil {
			return nil, err
		}
	}

	childResult, err := s.finishAgentRun(childRun.ID, missionID)
	if err != nil {
		return nil, err
	}

	eventType := domain.WorkflowEventChildRunCompleted
	message := fmt.Sprintf("%s agent completed.", workerName)
	if childResult.Status == domain.AgentRunStatusFailed || childResult.Status == domain.AgentRunStatusCancelled {
		eventType = domain.WorkflowEventChildRunFailed
		message = fmt.Sprintf("%s agent did not complete (%s).", workerName, childResult.Status)
	}
	if err := s.saveRunEvent(missionID, agent.RunEvent{WorkflowEvent: &domain.WorkflowEvent{
		ID:        fmt.Sprintf("event_%d", time.Now().UTC().UnixNano()),
		RunID:     parentRunID,
		Type:      eventType,
		Message:   message,
		CreatedAt: time.Now().UTC(),
	}}); err != nil {
		return nil, err
	}

	return childResult, nil
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
	} else if event.ChatMessage != nil {
		prefix = "CHAT:"
		data, err = json.Marshal(event.ChatMessage)
	}
	if err != nil || data == nil {
		return
	}
	// Concurrent child agents stream through one eventOut; serialize so their
	// NDJSON lines never interleave into corrupt JSON.
	s.streamMu.Lock()
	defer s.streamMu.Unlock()
	fmt.Fprintf(s.eventOut, "%s%s\n", prefix, data)
}

// streamAgentRun emits the run record itself (created, spawned as a child,
// finished) so the UI can grow the canvas while the run is still working
// instead of waiting for the final STATE snapshot.
func (s *Service) streamAgentRun(run domain.AgentRun) {
	if s.eventOut == nil {
		return
	}
	data, err := json.Marshal(run)
	if err != nil {
		return
	}
	s.streamMu.Lock()
	defer s.streamMu.Unlock()
	fmt.Fprintf(s.eventOut, "RUN:%s\n", data)
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
