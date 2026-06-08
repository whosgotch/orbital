package app

import (
	"fmt"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func (s *Service) CreateMission(repoID string, text string) (*domain.Mission, error) {
	missionText := strings.TrimSpace(text)
	if missionText == "" {
		return nil, fmt.Errorf("mission text is required")
	}

	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	repositoryExists := false
	for _, repository := range state.Repositories {
		if repository.ID == repoID {
			repositoryExists = true
			break
		}
	}

	if !repositoryExists {
		return nil, fmt.Errorf("repository not found: %s", repoID)
	}

	now := time.Now().UTC()
	mission := domain.Mission{
		ID:           fmt.Sprintf("mission_%d", now.UnixNano()),
		RepositoryID: repoID,
		Text:         missionText,
		Status:       domain.MissionStatusDraft,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	state.Missions = append(state.Missions, mission)

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	return &mission, nil
}
