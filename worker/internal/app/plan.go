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

// PlanResult is what the planner produces: a written plan document (authored in
// the requested format) plus the task nodes it proposes.
type PlanResult struct {
	Content  string
	Subtasks []ProposedSubtask
}

// planFunc explores a repo toward a goal and returns a plan. Injectable so
// PlanRepo is testable without the claude CLI.
type planFunc func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat) (PlanResult, error)

// PlanRepo runs a repo-level planning pass: the AI reads the repo, writes a plan
// for the goal in the chosen format, and proposes the tasks to get there. It
// records a plan node (holding the document) and the task nodes it fans out to
// (draft missions linked back by PlanID and chained by their dependencies).
// Nothing runs — the tasks are drafts the human reviews and launches.
func (s *Service) PlanRepo(ctx context.Context, repoID, goal string, format domain.PlanFormat) (*domain.Plan, []domain.Mission, error) {
	format = normalizePlanFormat(format)

	state, err := s.store.Load()
	if err != nil {
		return nil, nil, err
	}
	repoIndex := findRepositoryIndex(state.Repositories, repoID)
	if repoIndex == -1 {
		return nil, nil, fmt.Errorf("repository not found: %s", repoID)
	}
	repoPath := state.Repositories[repoIndex].Path

	planner := s.plan
	if planner == nil {
		planner = claudePlan
	}
	result, err := planner(ctx, s.runModel, repoPath, strings.TrimSpace(goal), format)
	if err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(result.Content) == "" {
		return nil, nil, fmt.Errorf("planner returned an empty plan")
	}

	now := time.Now().UTC()
	plan := domain.Plan{
		ID:           fmt.Sprintf("plan_%d", now.UnixNano()),
		RepositoryID: repoID,
		Goal:         strings.TrimSpace(goal),
		Format:       format,
		Content:      result.Content,
		CreatedAt:    now,
	}

	ids := make([]string, len(result.Subtasks))
	for i := range result.Subtasks {
		ids[i] = fmt.Sprintf("mission_%d_%d", now.UnixNano(), i)
	}
	created := make([]domain.Mission, 0, len(result.Subtasks))
	for i, subtask := range result.Subtasks {
		text := strings.TrimSpace(subtask.Text)
		if text == "" {
			text = strings.TrimSpace(subtask.Title)
		}
		if text == "" {
			continue
		}
		var deps []string
		for _, d := range subtask.DependsOn {
			if d >= 0 && d < i {
				deps = append(deps, ids[d])
			}
		}
		created = append(created, domain.Mission{
			ID:           ids[i],
			RepositoryID: repoID,
			Text:         text,
			Status:       domain.MissionStatusDraft,
			CreatedAt:    now,
			UpdatedAt:    now,
			PlanID:       plan.ID,
			DependsOn:    deps,
		})
	}

	if _, err := s.store.Update(func(state *store.State) error {
		if findRepositoryIndex(state.Repositories, repoID) == -1 {
			return fmt.Errorf("repository not found: %s", repoID)
		}
		state.Plans = append(state.Plans, plan)
		state.Missions = append(state.Missions, created...)
		return nil
	}); err != nil {
		return nil, nil, err
	}

	return &plan, created, nil
}

func normalizePlanFormat(format domain.PlanFormat) domain.PlanFormat {
	switch format {
	case domain.PlanFormatHTML, domain.PlanFormatText, domain.PlanFormatMarkdown:
		return format
	default:
		return domain.PlanFormatMarkdown
	}
}

func claudePlan(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat) (PlanResult, error) {
	out, err := agent.QueryClaudeInRepo(ctx, repoPath, model, planPrompt(goal, format))
	if err != nil {
		return PlanResult{}, err
	}
	return parsePlanResult(out)
}

func planPrompt(goal string, format domain.PlanFormat) string {
	formatName := "Markdown"
	switch format {
	case domain.PlanFormatHTML:
		formatName = "HTML (a self-contained fragment: headings, lists, maybe a table — no <html>/<head>/<body>, no scripts)"
	case domain.PlanFormatText:
		formatName = "plain text (an indented outline, no markup)"
	}

	goalLine := "The developer hasn't named a specific goal — survey the repo and propose the highest-value work."
	if strings.TrimSpace(goal) != "" {
		goalLine = "Goal: " + strings.TrimSpace(goal)
	}

	return `You are planning work on the repository in the current directory. Read the code to ground your plan in what is actually there.

` + goalLine + `

Produce:
1. A written plan authored in ` + formatName + `, explaining what to do and why.
2. A list of concrete task nodes that carry the plan out. Each task needs a short "title", a "text" prompt an engineer can act on directly, and "dependsOn": indices of earlier tasks that must finish first (empty if it can run in parallel).

Keep tasks few and real — only the work the goal actually needs, never busywork.

Output ONLY this JSON, no prose or fences around it:
{"plan": "<the plan document as a string, in the requested format>", "subtasks": [{"title": "...", "text": "...", "dependsOn": []}]}`
}

// parsePlanResult reads the planner's JSON, tolerating stray prose or fences.
func parsePlanResult(raw string) (PlanResult, error) {
	clean := extractJSONObject(raw)
	var parsed struct {
		Plan     string            `json:"plan"`
		Subtasks []ProposedSubtask `json:"subtasks"`
	}
	if err := json.Unmarshal([]byte(clean), &parsed); err != nil {
		return PlanResult{}, fmt.Errorf("plan: model output was not valid JSON: %w", err)
	}
	return PlanResult{Content: parsed.Plan, Subtasks: parsed.Subtasks}, nil
}
