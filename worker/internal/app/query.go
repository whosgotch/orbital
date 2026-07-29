package app

import (
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// LoadStateWithLiveBranches loads the current state and refreshes each
// repository's Branch field from the live git checkout. It never persists
// the refreshed value back to disk, and it never blanks out a stored
// branch when the path is no longer a git repository.
func (s *Service) LoadStateWithLiveBranches() (*store.State, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	for index, repository := range state.Repositories {
		if branch := currentGitBranch(repository.Path); branch != "" {
			state.Repositories[index].Branch = branch
		}
	}

	return state, nil
}

func (s *Service) ListRepositories() ([]domain.Repository, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	return append([]domain.Repository(nil), state.Repositories...), nil
}

func (s *Service) ListMissionsByRepository(repoID string) ([]domain.Mission, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	missions := make([]domain.Mission, 0)
	for _, mission := range state.Missions {
		if mission.RepositoryID == repoID {
			missions = append(missions, mission)
		}
	}

	return missions, nil
}

func (s *Service) ListRunsByMission(missionID string) ([]domain.AgentRun, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	runs := make([]domain.AgentRun, 0)
	for _, run := range state.AgentRuns {
		if run.MissionID == missionID {
			runs = append(runs, run)
		}
	}

	return runs, nil
}

func (s *Service) ListEventsByRun(runID string) ([]domain.WorkflowEvent, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	events := make([]domain.WorkflowEvent, 0)
	for _, event := range state.WorkflowEvents {
		if event.RunID == runID {
			events = append(events, event)
		}
	}

	return events, nil
}

func (s *Service) ListEventsByMission(missionID string) ([]domain.WorkflowEvent, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	events := make([]domain.WorkflowEvent, 0)
	for _, event := range state.WorkflowEvents {
		if event.MissionID == missionID {
			events = append(events, event)
		}
	}

	return events, nil
}

func (s *Service) ListPatchesByRun(runID string) ([]domain.PatchProposal, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	patches := make([]domain.PatchProposal, 0)
	for _, patch := range state.PatchProposals {
		if patch.RunID == runID {
			patches = append(patches, patch)
		}
	}

	return patches, nil
}

// ListChildRuns is intentionally parked for future visible-node decomposition:
// it enumerates the child agents an AI manager spawned, which the live
// single-engineer path does not use today. See agent.RunSpawner.
func (s *Service) ListChildRuns(parentRunID string) ([]domain.AgentRun, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	runs := make([]domain.AgentRun, 0)
	for _, run := range state.AgentRuns {
		if run.ParentRunID == parentRunID {
			runs = append(runs, run)
		}
	}

	return runs, nil
}
