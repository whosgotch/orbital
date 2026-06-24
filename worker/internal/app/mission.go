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
