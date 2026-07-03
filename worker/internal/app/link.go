package app

import (
	"fmt"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// LinkMissions makes the downstream mission wait for the upstream one: its
// agent should only start once the upstream mission's patch has landed. Links
// that would form a cycle are rejected so a chain can never deadlock itself.
func (s *Service) LinkMissions(fromMissionID string, toMissionID string) error {
	if fromMissionID == toMissionID {
		return fmt.Errorf("a mission cannot depend on itself")
	}

	_, err := s.store.Update(func(state *store.State) error {
		fromIndex := findMissionIndex(state.Missions, fromMissionID)
		if fromIndex == -1 {
			return fmt.Errorf("mission not found: %s", fromMissionID)
		}
		toIndex := findMissionIndex(state.Missions, toMissionID)
		if toIndex == -1 {
			return fmt.Errorf("mission not found: %s", toMissionID)
		}

		for _, id := range state.Missions[toIndex].DependsOn {
			if id == fromMissionID {
				return nil // already linked; keep the call idempotent
			}
		}
		if dependsTransitively(state.Missions, fromMissionID, toMissionID) {
			return fmt.Errorf("link would create a cycle")
		}

		state.Missions[toIndex].DependsOn = append(state.Missions[toIndex].DependsOn, fromMissionID)
		state.Missions[toIndex].UpdatedAt = time.Now().UTC()
		return nil
	})
	return err
}

// UnlinkMissions removes the upstream dependency again (a no-op when the link
// doesn't exist).
func (s *Service) UnlinkMissions(fromMissionID string, toMissionID string) error {
	_, err := s.store.Update(func(state *store.State) error {
		toIndex := findMissionIndex(state.Missions, toMissionID)
		if toIndex == -1 {
			return fmt.Errorf("mission not found: %s", toMissionID)
		}

		deps := state.Missions[toIndex].DependsOn
		remaining := deps[:0]
		for _, id := range deps {
			if id != fromMissionID {
				remaining = append(remaining, id)
			}
		}
		if len(remaining) == 0 {
			state.Missions[toIndex].DependsOn = nil
		} else {
			state.Missions[toIndex].DependsOn = remaining
		}
		state.Missions[toIndex].UpdatedAt = time.Now().UTC()
		return nil
	})
	return err
}

// dependsTransitively reports whether missionID already depends on targetID,
// directly or through a chain of upstream links.
func dependsTransitively(missions []domain.Mission, missionID string, targetID string) bool {
	depsByID := make(map[string][]string, len(missions))
	for _, mission := range missions {
		depsByID[mission.ID] = mission.DependsOn
	}

	seen := map[string]bool{}
	stack := []string{missionID}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if current == targetID {
			return true
		}
		if seen[current] {
			continue
		}
		seen[current] = true
		stack = append(stack, depsByID[current]...)
	}
	return false
}
