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

// ProposedSubtask is one task the planner carved the goal into. DependsOn
// holds indices of earlier sub-tasks that must land first, so the app can draw
// the same waits/parallel structure a human would by hand. BasedOn holds
// numbers of already-existing DONE nodes on the canvas (from the graph index
// handed to the planner) that this task builds on, empty when it stands alone.
type ProposedSubtask struct {
	Title     string `json:"title"`
	Text      string `json:"text"`
	DependsOn []int  `json:"dependsOn"`
	BasedOn   []int  `json:"basedOn"`
}

// planFunc explores a repo toward a goal and returns a plan, reporting each
// step (thought/action) to onStep as it happens. graphContext is the compact
// index of existing canvas work (see graphIndexFor), empty when the repo has
// no missions yet. Injectable so PlanRepo is testable without the claude CLI.
type planFunc func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error)

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
	graphContext, linkableIDs := graphIndexFor(state, repoID)

	planner := s.plan
	if planner == nil {
		planner = claudePlan
	}
	result, err := planner(ctx, s.runModel, repoPath, strings.TrimSpace(goal), format, graphContext, s.streamPlanEvent)
	if err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(result.Content) == "" {
		return nil, nil, fmt.Errorf("planner returned an empty plan")
	}
	// Planning never returns nothing to do: a plan with no proposed tasks falls
	// back to one task carrying the goal itself.
	if len(result.Subtasks) == 0 {
		fallback := strings.TrimSpace(goal)
		if fallback == "" {
			return nil, nil, fmt.Errorf("planner proposed no tasks")
		}
		result.Subtasks = []ProposedSubtask{{Text: fallback}}
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

	created := buildSubtaskMissions(repoID, plan.ID, "", result.Subtasks, now, linkableIDs)

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

// buildSubtaskMissions turns proposed subtasks into draft missions with
// sibling-only deps (indices before the subtask's own position — keeps the
// chain acyclic and ignores forward/self references a model might hallucinate).
// planID and campaignID may be empty. linkableIDs is the graph index's parallel
// ID slice (see graphIndexFor): entry n-1 is the real mission ID a subtask's
// basedOn number n resolves to, empty when that node isn't linkable. Callers
// with no graph context (or none built) pass nil, and every basedOn is ignored.
func buildSubtaskMissions(repoID, planID, campaignID string, subtasks []ProposedSubtask, now time.Time, linkableIDs []string) []domain.Mission {
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
			if d >= 0 && d < i {
				deps = append(deps, ids[d])
			}
		}
		for _, n := range subtask.BasedOn {
			index := n - 1
			if index < 0 || index >= len(linkableIDs) {
				continue
			}
			id := linkableIDs[index]
			if id == "" || containsString(deps, id) {
				continue
			}
			deps = append(deps, id)
		}
		created = append(created, domain.Mission{
			ID:           ids[i],
			RepositoryID: repoID,
			Text:         text,
			Status:       domain.MissionStatusDraft,
			CreatedAt:    now,
			UpdatedAt:    now,
			CampaignID:   campaignID,
			PlanID:       planID,
			DependsOn:    deps,
		})
	}
	return created
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

// graphIndexFor summarizes the last 30 missions of a repo (oldest to newest)
// as a compact numbered list the planner can reference by number, plus a
// parallel slice of mission IDs where entry i is Ni's mission ID — empty when
// that node isn't linkable (only verified/applied missions are, since only
// finished work is safe to depend on). Returns an empty string when the repo
// has no missions yet.
func graphIndexFor(state *store.State, repoID string) (string, []string) {
	var missions []domain.Mission
	for _, mission := range state.Missions {
		if mission.RepositoryID == repoID {
			missions = append(missions, mission)
		}
	}
	if len(missions) == 0 {
		return "", nil
	}
	if len(missions) > 30 {
		missions = missions[len(missions)-30:]
	}

	lines := make([]string, 0, len(missions))
	ids := make([]string, 0, len(missions))
	for i, mission := range missions {
		kind := string(mission.Kind)
		if kind == "" {
			kind = string(domain.MissionKindTask)
		}
		done := mission.Status == domain.MissionStatusVerified || mission.Status == domain.MissionStatusApplied
		statusLabel := string(mission.Status)
		if done {
			statusLabel = "done"
		}
		title := truncateInline(firstLine(mission.Text), 120)

		line := fmt.Sprintf("N%d [%s · %s] %s", i+1, kind, statusLabel, title)
		if done {
			if outcome := truncateInline(lastAssistantMessage(state, mission.ID), 200); outcome != "" {
				line += " — " + outcome
			}
			ids = append(ids, mission.ID)
		} else {
			ids = append(ids, "")
		}
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n"), ids
}

// firstLine is the first non-empty line of a mission's text, trimmed — the
// short title a graph index line shows.
func firstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// truncateInline caps s at limit runes with an ellipsis, no trailing newline —
// for text embedded mid-line (unlike truncateContext, which appends a
// "[truncated]" block for prose sections).
func truncateInline(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit]) + "…"
}

func normalizePlanFormat(format domain.PlanFormat) domain.PlanFormat {
	switch format {
	case domain.PlanFormatHTML, domain.PlanFormatText, domain.PlanFormatMarkdown:
		return format
	default:
		return domain.PlanFormatMarkdown
	}
}

func claudePlan(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
	out, err := agent.QueryClaudeInRepoStreaming(ctx, repoPath, model, planPrompt(goal, format, graphContext), onStep)
	if err != nil {
		return PlanResult{}, err
	}
	return parsePlanResult(out)
}

// streamPlanEvent surfaces one planner step as an EVENT: line so the UI can
// show the AI thinking live. Plan steps are ephemeral — streamed, never
// persisted — the durable artifact is the plan document itself.
func (s *Service) streamPlanEvent(kind, message string) {
	if s.eventOut == nil {
		return
	}
	eventType := domain.WorkflowEventAgentAction
	if kind == "thought" {
		eventType = domain.WorkflowEventAgentThought
	}
	data, err := json.Marshal(domain.WorkflowEvent{
		ID:        fmt.Sprintf("plan_event_%d", time.Now().UnixNano()),
		Type:      eventType,
		Message:   message,
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		return
	}
	s.streamMu.Lock()
	defer s.streamMu.Unlock()
	fmt.Fprintf(s.eventOut, "EVENT:%s\n", data)
}

func planPrompt(goal string, format domain.PlanFormat, graphContext string) string {
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

	graphSection := ""
	if strings.TrimSpace(graphContext) != "" {
		graphSection = "\n# Existing work on this canvas\nThese nodes already exist. If a task genuinely builds on one of them (continues it, uses its findings), reference it.\n" + graphContext + "\n"
	}

	return `You are planning work on the repository in the current directory. Read the code to ground your plan in what is actually there.

` + goalLine + `
` + graphSection + `
Produce:
1. A written plan authored in ` + formatName + `, explaining what to do and why.
2. The FEWEST concrete task nodes that carry the plan out — a single task is a perfectly good answer for a focused goal; only split when the work genuinely contains distinct pieces. Each task needs a short "title", a "text" prompt an engineer can act on directly, "dependsOn": indices of earlier tasks that must finish first (empty if it can run in parallel), and "basedOn": numbers of existing DONE nodes above that it builds on (empty when it stands alone).

Keep tasks few and real — only the work the goal actually needs, never busywork. Never propose a testing/verifying/reviewing task: verification is a lifecycle stage every task already has.

Output ONLY this JSON, no prose or fences around it. Your reply must start with { and end with }:
{"plan": "<the plan document as a string, in the requested format>", "subtasks": [{"title": "...", "text": "...", "dependsOn": [], "basedOn": []}]}`
}

// parsePlanResult reads the planner's JSON, tolerating stray prose or fences.
// An {"atomic": true} answer yields an empty result: the work is one coherent
// change, no plan or split needed. A model that ignores the JSON contract and
// answers in prose usually still wrote a plan — that prose becomes the plan
// document (with the fallback single task), rather than throwing the whole
// exploration away.
func parsePlanResult(raw string) (PlanResult, error) {
	clean := extractJSONObject(raw)
	var parsed struct {
		Atomic   bool              `json:"atomic"`
		Plan     string            `json:"plan"`
		Subtasks []ProposedSubtask `json:"subtasks"`
	}
	if err := json.Unmarshal([]byte(clean), &parsed); err != nil {
		if prose := strings.TrimSpace(raw); prose != "" {
			return PlanResult{Content: prose}, nil
		}
		return PlanResult{}, fmt.Errorf("plan: model output was not valid JSON: %w", err)
	}
	if parsed.Atomic {
		return PlanResult{}, nil
	}
	return PlanResult{Content: parsed.Plan, Subtasks: parsed.Subtasks}, nil
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
