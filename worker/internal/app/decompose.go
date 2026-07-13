package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// ProposedSubtask is one piece the planner carved a task into. DependsOn
// holds indices of earlier sub-tasks that must land first, so the app can draw
// the same waits/parallel structure a human would by hand.
type ProposedSubtask struct {
	Title     string `json:"title"`
	Text      string `json:"text"`
	DependsOn []int  `json:"dependsOn"`
}

// decomposeFunc plans a task's split inside its repo: it returns a plan
// document explaining the split plus the sub-tasks, or empty Subtasks when the
// task is a single coherent change that should not be split. Injectable so the
// split logic is testable without the claude CLI.
type decomposeFunc func(ctx context.Context, model, repoPath, missionText string) (PlanResult, error)

// DecomposeMission breaks a draft task into sub-task nodes plan-first: the AI
// reads the repo, writes a plan for the split, and only splits when the work is
// genuinely several pieces — a coherent task returns unchanged (nil, nil).
// When it does split, the umbrella node is replaced by a plan node (holding the
// written plan) fanning out to the sub-tasks (draft nodes you can still edit,
// delete, chain, or run). Dependencies are rewired rather than dropped: root
// sub-tasks inherit the umbrella's upstream deps, and anything that waited on
// the umbrella now waits on its terminal sub-tasks.
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
	repoIndex := findRepositoryIndex(state.Repositories, mission.RepositoryID)
	if repoIndex == -1 {
		return nil, fmt.Errorf("repository not found: %s", mission.RepositoryID)
	}
	repoPath := state.Repositories[repoIndex].Path

	decompose := s.decompose
	if decompose == nil {
		decompose = claudeDecompose
	}
	result, err := decompose(ctx, s.runModel, repoPath, mission.Text)
	if err != nil {
		return nil, err
	}
	// The planner judged it one coherent change (or found nothing worth
	// separating). Leave the node exactly as it was.
	if len(result.Subtasks) < 2 || strings.TrimSpace(result.Content) == "" {
		return nil, nil
	}

	now := time.Now().UTC()
	plan := domain.Plan{
		ID:           fmt.Sprintf("plan_%d", now.UnixNano()),
		RepositoryID: mission.RepositoryID,
		Goal:         mission.Text,
		Format:       domain.PlanFormatMarkdown,
		Content:      result.Content,
		CreatedAt:    now,
	}
	created := buildSubtaskMissions(mission.RepositoryID, plan.ID, mission.CampaignID, result.Subtasks, now)
	if len(created) < 2 {
		return nil, nil
	}

	// Root sub-tasks (no sibling deps) inherit the umbrella's upstream deps:
	// they must wait for whatever the umbrella waited for. Terminal sub-tasks
	// (no sibling depends on them) stand in for the umbrella downstream.
	dependedOn := make(map[string]bool)
	for i := range created {
		for _, id := range created[i].DependsOn {
			dependedOn[id] = true
		}
		if len(created[i].DependsOn) == 0 {
			created[i].DependsOn = append([]string(nil), mission.DependsOn...)
		}
	}
	var terminals []string
	for _, m := range created {
		if !dependedOn[m.ID] {
			terminals = append(terminals, m.ID)
		}
	}

	if _, err := s.store.Update(func(state *store.State) error {
		index := findMissionIndex(state.Missions, missionID)
		if index == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}
		if state.Missions[index].Status != domain.MissionStatusDraft {
			return fmt.Errorf("only a draft task can be broken up")
		}
		// Replace the umbrella node with a plan fanning out to its sub-tasks:
		// break-this-up turns one node into a reviewed plan plus several tasks.
		state.Missions = append(state.Missions[:index], state.Missions[index+1:]...)
		state.Missions = append(state.Missions, created...)
		state.Plans = append(state.Plans, plan)

		// Rewire any dependency on the removed umbrella to its terminal
		// sub-tasks so nothing waits on a mission that no longer exists.
		for i := range state.Missions {
			deps := state.Missions[i].DependsOn
			kept := deps[:0]
			for _, id := range deps {
				if id == missionID {
					kept = append(kept, terminals...)
				} else {
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

func claudeDecompose(ctx context.Context, model, repoPath, missionText string) (PlanResult, error) {
	out, err := agent.QueryClaudeInRepo(ctx, repoPath, model, decomposePrompt(missionText))
	if err != nil {
		return PlanResult{}, err
	}
	return parsePlanResult(out)
}

// decomposePrompt biases hard toward NOT splitting: over-splitting produces
// noise, so a task only breaks apart when it plainly contains separate pieces.
func decomposePrompt(missionText string) string {
	return `You split a software task into the FEWEST independent sub-tasks a developer would actually track as separate units of work. The task targets the repository in the current directory — read the code to ground the split in what is actually there.

Rules:
- Strongly prefer NOT splitting. If the task is a single coherent change, return exactly: {"atomic": true}
- Only split when the task clearly contains distinct pieces (e.g. separate features, or a piece that must land before another can use it).
- Never produce more than 4 sub-tasks.
- When splitting, also write a short plan in Markdown explaining how the task breaks apart and why, grounded in the code.
- Each sub-task needs a short "title", a "text" prompt an engineer can act on directly, and "dependsOn": a list of indices of earlier sub-tasks that must finish first (empty if it can run in parallel).
- Output ONLY JSON, no prose, no code fences.

JSON shape when splitting:
{"plan": "<the plan document in Markdown>", "subtasks": [{"title": "...", "text": "...", "dependsOn": []}]}

Task:
` + missionText
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
