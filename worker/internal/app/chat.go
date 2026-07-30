package app

import (
	"context"
	"fmt"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

const engineerWorkerName = "claude-engineer"

// SendAgentMessage sends one chat turn to a mission's agent. The first message
// starts a fresh claude session in an isolated worktree; every later message
// resumes that same session, so the agent keeps its context and its diff
// evolves in place across the conversation instead of starting over each time.
func (s *Service) SendAgentMessage(ctx context.Context, missionID string, text string) (*domain.AgentRun, error) {
	loaded, err := s.store.Load()
	if err != nil {
		return nil, err
	}
	if findMissionIndex(loaded.Missions, missionID) == -1 {
		return nil, fmt.Errorf("mission not found: %s", missionID)
	}
	chatWorkerName := engineerWorkerName

	worker, err := s.workerRegistry.Lookup(chatWorkerName)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()

	// Resolve the mission's live chat agent (a claude-engineer run that already
	// owns a session), or mint a new run for the first turn.
	var run domain.AgentRun
	var repoPath, upstreamCtx string
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
		// A first chat turn starts a fresh session — hand it the upstream edge
		// data the same way a run gets it. Resumed sessions already have it.
		upstreamCtx, _ = upstreamContextFor(state, state.Missions[missionIndex])

		if existing := latestChatRun(state.AgentRuns, missionID, chatWorkerName); existing != nil {
			run = *existing
		} else {
			run = domain.AgentRun{
				ID:         fmt.Sprintf("run_%d", now.UnixNano()),
				MissionID:  missionID,
				WorkerName: chatWorkerName,
				Status:     domain.AgentRunStatusRunning,
				StartedAt:  now,
			}
			state.AgentRuns = append(state.AgentRuns, run)
		}

		if runIndex := findRunIndex(state.AgentRuns, run.ID); runIndex != -1 {
			state.AgentRuns[runIndex].Status = domain.AgentRunStatusRunning
			state.AgentRuns[runIndex].CompletedAt = nil
		}
		state.Missions[missionIndex].Status = domain.MissionStatusRunning
		state.Missions[missionIndex].UpdatedAt = now
		return nil
	}); err != nil {
		return nil, err
	}

	s.streamAgentRun(run)

	userMessage := domain.ChatMessage{
		ID:        fmt.Sprintf("msg_%d", now.UnixNano()),
		MissionID: missionID,
		RunID:     run.ID,
		Role:      domain.ChatRoleUser,
		Text:      text,
		CreatedAt: now,
	}
	if err := s.saveRunEvent(missionID, agent.RunEvent{ChatMessage: &userMessage}); err != nil {
		return nil, err
	}

	// Give a first-turn run its own worktree so it never shares a working tree
	// with other agents; later turns reuse it so the diff accumulates.
	workdir := repoPath
	if run.WorktreePath != "" {
		workdir = run.WorktreePath
	} else {
		s.worktreeMu.Lock()
		worktreePath, err := createRunWorktree(ctx, repoPath, run.ID)
		s.worktreeMu.Unlock()
		if err != nil {
			return nil, s.failRun(run, missionID, repoPath, err)
		}
		if worktreePath != "" {
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
	}

	runRequest := agent.RunRequest{
		RunID:           run.ID,
		MissionID:       missionID,
		RepoPath:        workdir,
		MissionText:     text,
		ResumeSessionID: run.SessionID,
		Model:           s.runModel,
		Effort:          s.runEffort,
		UpstreamContext: upstreamCtx,
	}

	events, err := worker.StartRun(ctx, runRequest)
	if err != nil {
		return nil, err
	}

	var capturedSession string
	var turnUsage *domain.RunUsage
	for event := range events {
		if event.SessionID != "" {
			capturedSession = event.SessionID
		}
		if event.Usage != nil {
			turnUsage = event.Usage
		}
		if err := s.saveRunEvent(missionID, event); err != nil {
			return nil, err
		}
	}

	// Persist the session so the next turn resumes this conversation, and fold this
	// turn's tokens into the run's running totals so the node's context fill and
	// total spend keep climbing across the whole conversation.
	if capturedSession != "" || turnUsage != nil {
		if _, err := s.store.Update(func(state *store.State) error {
			if runIndex := findRunIndex(state.AgentRuns, run.ID); runIndex != -1 {
				if capturedSession != "" {
					state.AgentRuns[runIndex].SessionID = capturedSession
				}
				state.AgentRuns[runIndex].Usage = state.AgentRuns[runIndex].Usage.Merge(turnUsage)
			}
			return nil
		}); err != nil {
			return nil, err
		}
	}

	return s.finishAgentRun(run.ID, missionID)
}

// latestChatRun returns the mission's most recent resumable chat agent — a
// run of the given worker that has already captured a session — or nil if none.
func latestChatRun(runs []domain.AgentRun, missionID string, workerName string) *domain.AgentRun {
	var latest *domain.AgentRun
	for i := range runs {
		run := &runs[i]
		if run.MissionID != missionID || run.WorkerName != workerName || run.SessionID == "" {
			continue
		}
		if latest == nil || run.StartedAt.After(latest.StartedAt) {
			latest = run
		}
	}
	return latest
}
