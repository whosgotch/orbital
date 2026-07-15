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

// extractionFindingsLimit caps how much of the research document rides into
// the extraction prompt — generous since the document is the whole point.
const extractionFindingsLimit = 12000

// ProposedSubtask lives in domain (buildSubtaskMissions consumes it directly);
// aliased here so this package's call sites don't need the domain prefix.
type ProposedSubtask = domain.ProposedSubtask

// extractFunc turns a research document into the tasks its findings call for,
// reporting each step (thought/action) to onStep as it happens. graphContext
// is the compact index of existing canvas work (see graphIndexFor), empty
// when the repo has no missions yet. Injectable so ExtractTasks is testable
// without the claude CLI.
type extractFunc func(ctx context.Context, model, repoPath, document, graphContext string, onStep func(kind, text string)) ([]ProposedSubtask, error)

// ExtractTasks turns a research mission's findings document into the fewest
// concrete draft missions its conclusions call for. Each is chained after the
// research mission (DependsOn), so its findings flow down the same edge every
// task→task hand-off already uses (see upstreamContextFor) — no separate
// plumbing is needed to get the document to the engineer.
func (s *Service) ExtractTasks(ctx context.Context, missionID string) ([]domain.Mission, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}
	missionIndex := findMissionIndex(state.Missions, missionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", missionID)
	}
	mission := state.Missions[missionIndex]
	if !mission.IsResearch() {
		return nil, fmt.Errorf("mission is not research: %s", missionID)
	}
	document := strings.TrimSpace(mission.Document)
	if document == "" {
		return nil, fmt.Errorf("mission has no research document: %s", missionID)
	}
	repositoryIndex := findRepositoryIndex(state.Repositories, mission.RepositoryID)
	if repositoryIndex == -1 {
		return nil, fmt.Errorf("repository not found: %s", mission.RepositoryID)
	}
	repoPath := state.Repositories[repositoryIndex].Path
	graphContext, linkableIDs := graphIndexFor(state, mission.RepositoryID)

	extractor := s.extract
	if extractor == nil {
		extractor = claudeExtract
	}
	subtasks, err := extractor(ctx, s.runModel, repoPath, document, graphContext, s.streamExtractEvent)
	if err != nil {
		return nil, err
	}
	if len(subtasks) == 0 {
		return nil, fmt.Errorf("extraction proposed no tasks")
	}

	now := time.Now().UTC()
	var created []domain.Mission
	if _, err := s.store.Update(func(state *store.State) error {
		if findMissionIndex(state.Missions, missionID) == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}
		created = buildSubtaskMissions(mission.RepositoryID, "", subtasks, now, linkableIDs)
		// Chain every extracted task after the research mission so its findings
		// flow down via the ordinary upstream hand-off (dedupe: a subtask that
		// already basedOn'd its own research node shouldn't double up).
		for i := range created {
			if !containsString(created[i].DependsOn, missionID) {
				created[i].DependsOn = append(created[i].DependsOn, missionID)
			}
		}
		state.Missions = append(state.Missions, created...)
		return nil
	}); err != nil {
		return nil, err
	}

	return created, nil
}

// buildSubtaskMissions turns proposed subtasks into draft missions with
// sibling-only deps (indices before the subtask's own position — keeps the
// chain acyclic and ignores forward/self references a model might
// hallucinate). campaignID may be empty. linkableIDs is the graph index's
// parallel ID slice (see graphIndexFor): entry n-1 is the real mission ID a
// subtask's basedOn number n resolves to, empty when that node isn't
// linkable. Callers with no graph context (or none built) pass nil, and every
// basedOn is ignored.
func buildSubtaskMissions(repoID, campaignID string, subtasks []ProposedSubtask, now time.Time, linkableIDs []string) []domain.Mission {
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
			Title:        strings.TrimSpace(subtask.Title),
			Text:         text,
			Status:       domain.MissionStatusDraft,
			CreatedAt:    now,
			UpdatedAt:    now,
			CampaignID:   campaignID,
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
// as a compact numbered list the extractor can reference by number, plus a
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

// extractQueryFunc matches agent.QueryClaudeInRepoStreaming's signature.
// Injected into extractWithRepair so tests can fake both the extraction call
// and the repair call without touching the claude CLI.
type extractQueryFunc func(ctx context.Context, repoPath, model, prompt string, onStep func(kind, text string)) (string, error)

func claudeExtract(ctx context.Context, model, repoPath, document, graphContext string, onStep func(kind, text string)) ([]ProposedSubtask, error) {
	return extractWithRepair(ctx, agent.QueryClaudeInRepoStreaming, model, repoPath, document, graphContext, onStep)
}

// extractWithRepair runs the extraction query and, when the reply doesn't
// parse as the JSON contract (or parses with zero tasks), makes one follow-up
// call asking the model to convert its own reply into that contract. Unlike
// planning there is no prose to salvage here — the research document already
// exists — so a repair that still fails to parse is a hard error.
func extractWithRepair(ctx context.Context, query extractQueryFunc, model, repoPath, document, graphContext string, onStep func(kind, text string)) ([]ProposedSubtask, error) {
	raw, err := query(ctx, repoPath, model, extractionPrompt(document, graphContext), onStep)
	if err != nil {
		return nil, err
	}
	if subtasks, ok := parseExtractResult(raw); ok && len(subtasks) > 0 {
		return subtasks, nil
	}

	onStep("action", "repairing extraction output")
	repairedRaw, repairErr := query(ctx, repoPath, model, extractRepairPrompt(raw), onStep)
	if repairErr != nil {
		return nil, fmt.Errorf("extraction: model output was not valid JSON: %w", repairErr)
	}
	subtasks, ok := parseExtractResult(repairedRaw)
	if !ok || len(subtasks) == 0 {
		return nil, fmt.Errorf("extraction: model output was not valid JSON, repair also failed")
	}
	return subtasks, nil
}

func extractionPrompt(document, graphContext string) string {
	graphSection := ""
	if strings.TrimSpace(graphContext) != "" {
		graphSection = "\n# Existing work on this canvas\nThese nodes already exist. If a task genuinely builds on one of them (continues it, uses its findings), reference it.\n" + graphContext + "\n"
	}

	return `You are turning a research findings document into concrete work. Read it closely — it is the only source of truth for what to propose.

# Research findings
` + truncateContext(document, extractionFindingsLimit) + `
` + graphSection + `
Propose the FEWEST concrete tasks the findings actually call for — a single task is a perfectly good answer; only split when the work genuinely contains distinct pieces. Never invent work the document doesn't support, and never propose a testing/verifying/reviewing task: verification is a lifecycle stage every task already has.

Each task needs a "title" (3-6 words, imperative, like a kanban card label), a "text" prompt (2-4 sentences, concise and actionable — the engineer running it receives the research document alongside, so point at the relevant finding instead of restating it), "dependsOn": indices of earlier tasks in this list that must finish first (empty if it can run in parallel), and "basedOn": numbers of existing DONE nodes above that it builds on (empty when it stands alone).

Output ONLY this JSON, no prose or fences around it. Your reply must start with { and end with }:
{"subtasks": [{"title": "...", "text": "...", "dependsOn": [], "basedOn": []}]}`
}

// extractRepairPrompt asks the model to turn its own prior reply into the
// contract JSON, extracting only the tasks that reply already describes.
func extractRepairPrompt(rawReply string) string {
	return `Your previous reply below did not follow the required output format. Convert it into the contract JSON.

Extract only the tasks your reply already describes — never invent new work.

Output ONLY this JSON, no prose or fences around it. Your reply must start with { and end with }:
{"subtasks": [{"title": "...", "text": "...", "dependsOn": [], "basedOn": []}]}

Your previous reply:
` + rawReply
}

// parseExtractResult reads the extractor's JSON, tolerating stray prose or
// fences around it. Returns ok=false when the reply isn't the contract JSON.
func parseExtractResult(raw string) ([]ProposedSubtask, bool) {
	clean := extractJSONObject(raw)
	var parsed struct {
		Subtasks []ProposedSubtask `json:"subtasks"`
	}
	if err := json.Unmarshal([]byte(clean), &parsed); err != nil {
		return nil, false
	}
	return parsed.Subtasks, true
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

// streamExtractEvent surfaces one extraction step as an EVENT: line so a
// caller streaming eventOut can show the AI thinking live — the CLI's
// extract-tasks command runs as a blocking call and never sets eventOut, so
// this is a no-op there; the plumbing just mirrors every other claude-backed
// pass in this package. Extraction steps are ephemeral — never persisted.
func (s *Service) streamExtractEvent(kind, message string) {
	if s.eventOut == nil {
		return
	}
	eventType := domain.WorkflowEventAgentAction
	if kind == "thought" {
		eventType = domain.WorkflowEventAgentThought
	}
	data, err := json.Marshal(domain.WorkflowEvent{
		ID:        fmt.Sprintf("extract_event_%d", time.Now().UnixNano()),
		Type:      eventType,
		Message:   message,
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		return
	}
	s.streamMu.Lock()
	defer s.streamMu.Unlock()
	_, _ = fmt.Fprintf(s.eventOut, "EVENT:%s\n", data)
}
