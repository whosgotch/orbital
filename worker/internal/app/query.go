package app

import "github.com/whosgotch/orbital/worker/internal/domain"

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

func (s *Service) ListVerificationsByMission(missionID string) ([]domain.VerificationRun, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	verifications := make([]domain.VerificationRun, 0)
	for _, verification := range state.VerificationRuns {
		if verification.MissionID == missionID {
			verifications = append(verifications, verification)
		}
	}

	return verifications, nil
}
