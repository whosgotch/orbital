package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// ProposedSubtask is one piece the decomposer carved a task into. DependsOn
// holds indices of earlier sub-tasks that must land first, so the app can draw
// the same waits/parallel structure a human would by hand.
type ProposedSubtask struct {
	Title     string `json:"title"`
	Text      string `json:"text"`
	DependsOn []int  `json:"dependsOn"`
}

// decomposeFunc turns a task's prompt into sub-tasks. It returns an empty slice
// when the task is a single coherent change that should not be split. Injectable
// so the split logic is testable without the claude CLI.
type decomposeFunc func(ctx context.Context, model, missionText string) ([]ProposedSubtask, error)

// DecomposeMission breaks a draft task into sub-task nodes, but only when the
// work is genuinely several pieces — the decomposer is asked to prefer NOT
// splitting, so a coherent task returns unchanged (nil, nil). When it does
// split, the original node is replaced by its sub-tasks (draft nodes you can
// still edit, delete, chain, or run), with dependency links carried over so
// independent pieces run in parallel and sequential ones wait.
func (s *Service) DecomposeMission(ctx context.Context, missionID string) ([]domain.Mission, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}
	missionIndex := findMissionIndex(state.Missions, missionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", missionID)
	}
	mission := state.Missions[missionIndex]
	if mission.IsTool() {
		return nil, fmt.Errorf("a tool step cannot be broken up")
	}
	if mission.Status != domain.MissionStatusDraft {
		return nil, fmt.Errorf("only a draft task can be broken up")
	}

	decompose := s.decompose
	if decompose == nil {
		decompose = claudeDecompose
	}
	subtasks, err := decompose(ctx, s.runModel, mission.Text)
	if err != nil {
		return nil, err
	}
	// The decomposer judged it one coherent change (or found nothing worth
	// separating). Leave the node exactly as it was.
	if len(subtasks) < 2 {
		return nil, nil
	}

	now := time.Now().UTC()
	ids := make([]string, len(subtasks))
	for i := range subtasks {
		ids[i] = fmt.Sprintf("mission_%d_%d", now.UnixNano(), i)
	}

	created := make([]domain.Mission, 0, len(subtasks))
	for i, subtask := range subtasks {
		text := strings.TrimSpace(subtask.Text)
		if text == "" {
			text = strings.TrimSpace(subtask.Title)
		}
		if text == "" {
			continue
		}
		var deps []string
		for _, d := range subtask.DependsOn {
			// Only depend on earlier siblings: that keeps the chain acyclic and
			// ignores any forward or self reference a model might hallucinate.
			if d >= 0 && d < i {
				deps = append(deps, ids[d])
			}
		}
		created = append(created, domain.Mission{
			ID:           ids[i],
			RepositoryID: mission.RepositoryID,
			Text:         text,
			Status:       domain.MissionStatusDraft,
			CreatedAt:    now,
			UpdatedAt:    now,
			CampaignID:   mission.CampaignID,
			DependsOn:    deps,
		})
	}
	if len(created) < 2 {
		return nil, nil
	}

	if _, err := s.store.Update(func(state *store.State) error {
		index := findMissionIndex(state.Missions, missionID)
		if index == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}
		if state.Missions[index].Status != domain.MissionStatusDraft {
			return fmt.Errorf("only a draft task can be broken up")
		}
		// Replace the umbrella node with its sub-tasks: break-this-up turns one
		// node into several rather than leaving the original prompt behind.
		state.Missions = append(state.Missions[:index], state.Missions[index+1:]...)
		state.Missions = append(state.Missions, created...)

		// Drop any dangling dependency on the node we just removed so nothing is
		// left waiting on a mission that no longer exists.
		for i := range state.Missions {
			deps := state.Missions[i].DependsOn
			kept := deps[:0]
			for _, id := range deps {
				if id != missionID {
					kept = append(kept, id)
				}
			}
			if len(kept) == 0 {
				state.Missions[i].DependsOn = nil
			} else {
				state.Missions[i].DependsOn = kept
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return created, nil
}

func claudeDecompose(ctx context.Context, model, missionText string) ([]ProposedSubtask, error) {
	out, err := agent.QueryClaudeText(ctx, model, decomposePrompt(missionText))
	if err != nil {
		return nil, err
	}
	return parseDecomposition(out)
}

// decomposePrompt biases hard toward NOT splitting: over-splitting produces
// noise, so a task only breaks apart when it plainly contains separate pieces.
func decomposePrompt(missionText string) string {
	return `You split a software task into the FEWEST independent sub-tasks a developer would actually track as separate units of work.

Rules:
- Strongly prefer NOT splitting. If the task is a single coherent change, return exactly: {"atomic": true}
- Only split when the task clearly contains distinct pieces (e.g. separate features, or a piece that must land before another can use it).
- Never produce more than 4 sub-tasks.
- Each sub-task needs a short "title", a "text" prompt an engineer can act on directly, and "dependsOn": a list of indices of earlier sub-tasks that must finish first (empty if it can run in parallel).
- Output ONLY JSON, no prose, no code fences.

JSON shape when splitting:
{"subtasks": [{"title": "...", "text": "...", "dependsOn": []}]}

Task:
` + missionText
}

// parseDecomposition reads the model's JSON, tolerating stray prose or code
// fences around it. An {"atomic": true} answer (or no sub-tasks) yields nil.
func parseDecomposition(raw string) ([]ProposedSubtask, error) {
	clean := extractJSONObject(raw)
	var parsed struct {
		Atomic   bool              `json:"atomic"`
		Subtasks []ProposedSubtask `json:"subtasks"`
	}
	if err := json.Unmarshal([]byte(clean), &parsed); err != nil {
		return nil, fmt.Errorf("decompose: model output was not valid JSON: %w", err)
	}
	if parsed.Atomic {
		return nil, nil
	}
	return parsed.Subtasks, nil
}

// extractJSONObject slices out the first {...} span, so a model that wraps its
// JSON in ```json fences or a sentence still parses.
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}
