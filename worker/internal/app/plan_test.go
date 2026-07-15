package app

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func planState(t *testing.T) *store.JSONStore {
	t.Helper()
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	return jsonStore
}

// A planning pass records a plan node (holding the written document and the
// proposed tasks) but does not materialize any missions — those wait for
// ApprovePlan.
func TestPlanRepoRecordsPlanWithoutMaterializingTasks(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{
			Content: "# Plan\n1. Add parser\n2. Wire CLI",
			Subtasks: []ProposedSubtask{
				{Title: "parser", Text: "add parse_config in config.py"},
				{Title: "cli", Text: "use parse_config in cli.py", DependsOn: []int{0}},
			},
		}, nil
	})

	plan, err := svc.PlanRepo(context.Background(), "repo_1", "make the config loadable", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}
	if plan.Content == "" || plan.Format != domain.PlanFormatMarkdown || plan.Goal != "make the config loadable" {
		t.Fatalf("plan not recorded correctly: %+v", plan)
	}
	if len(plan.Subtasks) != 2 {
		t.Fatalf("plan.Subtasks = %d, want 2", len(plan.Subtasks))
	}
	if plan.ApprovedAt != nil {
		t.Fatalf("plan should be unapproved, got ApprovedAt = %v", plan.ApprovedAt)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.Plans) != 1 || state.Plans[0].ID != plan.ID {
		t.Fatalf("plan not persisted: %+v", state.Plans)
	}
	if len(state.Missions) != 0 {
		t.Fatalf("expected no missions materialized yet, got %+v", state.Missions)
	}
}

// A plan that proposes no tasks still yields one: the goal itself becomes the
// single proposed task, so planning never produces an empty fan-out.
func TestPlanRepoFallsBackToSingleTask(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{Content: "## Plan\nOne focused change."}, nil
	})

	plan, err := svc.PlanRepo(context.Background(), "repo_1", "fix the typo in README", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}
	if len(plan.Subtasks) != 1 || plan.Subtasks[0].Text != "fix the typo in README" {
		t.Fatalf("plan.Subtasks = %+v, want one task carrying the goal", plan.Subtasks)
	}
}

// Planner steps stream as EVENT: NDJSON lines on eventOut, and are ephemeral —
// none of them end up persisted in the state.
func TestPlanRepoStreamsStepsWithoutPersistingThem(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	var out bytes.Buffer
	svc.SetEventOut(&out)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		onStep("thought", "surveying the parser")
		onStep("action", "Read(config.py)")
		return PlanResult{Content: "plan", Subtasks: []ProposedSubtask{{Text: "do it"}}}, nil
	})

	if _, err := svc.PlanRepo(context.Background(), "repo_1", "goal", domain.PlanFormatMarkdown); err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "EVENT:") || !strings.HasPrefix(lines[1], "EVENT:") {
		t.Fatalf("streamed lines = %q, want two EVENT: lines", out.String())
	}
	if !strings.Contains(lines[0], "agent_thought") || !strings.Contains(lines[1], "agent_action") {
		t.Fatalf("event types wrong: %q", out.String())
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.WorkflowEvents) != 0 {
		t.Fatalf("plan steps must not persist, got %+v", state.WorkflowEvents)
	}
}

// An unknown format falls back to markdown rather than storing something the UI
// can't render.
func TestPlanRepoNormalizesUnknownFormat(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		if format != domain.PlanFormatMarkdown {
			t.Fatalf("planner got format %q, want normalized md", format)
		}
		return PlanResult{Content: "plan", Subtasks: []ProposedSubtask{{Text: "tidy"}}}, nil
	})

	plan, err := svc.PlanRepo(context.Background(), "repo_1", "", domain.PlanFormat("bogus"))
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}
	if plan.Format != domain.PlanFormatMarkdown {
		t.Fatalf("plan.Format = %q, want md", plan.Format)
	}
}

func TestPlanRepoRejectsUnknownRepo(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{Content: "plan"}, nil
	})
	if _, err := svc.PlanRepo(context.Background(), "nope", "goal", domain.PlanFormatMarkdown); err == nil {
		t.Fatal("PlanRepo() with unknown repo should error")
	}
}

// The graph index numbers each mission of the repo oldest-to-newest, marks
// done ones (verified or applied) with their outcome, and returns a parallel
// ID slice where only done entries carry a real ID.
func TestGraphIndexForNumbersDoneAndDraftMissions(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	state := &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "m1", RepositoryID: "repo_1", Kind: domain.MissionKindResearch, Text: "how does the plan engine work?\nmore detail", Status: domain.MissionStatusVerified},
			{ID: "m2", RepositoryID: "repo_1", Kind: domain.MissionKindTask, Text: "wire the planner", Status: domain.MissionStatusDraft},
			{ID: "other", RepositoryID: "repo_2", Kind: domain.MissionKindTask, Text: "unrelated repo", Status: domain.MissionStatusVerified},
		},
		ChatMessages: []domain.ChatMessage{
			{ID: "c1", MissionID: "m1", RunID: "run_1", Role: domain.ChatRoleAssistant, Text: "The plan engine reads state and calls claude."},
		},
	}
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	index, ids := graphIndexFor(loaded, "repo_1")

	if !strings.Contains(index, "N1 [research · done] how does the plan engine work? — The plan engine reads state and calls claude.") {
		t.Fatalf("index missing done research line:\n%s", index)
	}
	if !strings.Contains(index, "N2 [task · draft] wire the planner") {
		t.Fatalf("index missing draft task line:\n%s", index)
	}
	if strings.Contains(index, "unrelated repo") {
		t.Fatalf("index leaked another repo's mission:\n%s", index)
	}
	if len(ids) != 2 || ids[0] != "m1" || ids[1] != "" {
		t.Fatalf("ids = %v, want [m1, \"\"]", ids)
	}
}

// Only the last 30 missions of the repo make the index, oldest of the kept
// window first.
func TestGraphIndexForCapsAtThirtyMissions(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	missions := make([]domain.Mission, 0, 35)
	for i := 0; i < 35; i++ {
		missions = append(missions, domain.Mission{
			ID:           fmt.Sprintf("m%d", i),
			RepositoryID: "repo_1",
			Text:         fmt.Sprintf("task %d", i),
			Status:       domain.MissionStatusDraft,
		})
	}
	state := &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions:     missions,
	}
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	index, ids := graphIndexFor(loaded, "repo_1")

	if len(ids) != 30 {
		t.Fatalf("ids len = %d, want 30", len(ids))
	}
	if !strings.Contains(index, "task 5") {
		t.Fatalf("index dropped the oldest kept mission (task 5):\n%s", index)
	}
	if strings.Contains(index, "task 4 ") || strings.Contains(index, "task 4\n") {
		t.Fatalf("index kept a mission outside the 30 cap:\n%s", index)
	}
	if !strings.Contains(index, "task 34") {
		t.Fatalf("index missing the newest mission:\n%s", index)
	}
}

// No missions in the repo yields an empty index and no IDs.
func TestGraphIndexForEmptyWithNoMissions(t *testing.T) {
	jsonStore := planState(t)
	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	index, ids := graphIndexFor(state, "repo_1")

	if index != "" || ids != nil {
		t.Fatalf("expected empty index, got %q / %v", index, ids)
	}
}

// A subtask whose basedOn references an existing verified mission gets that
// mission's real ID appended to its DependsOn; a basedOn pointing at a
// non-linkable (draft) node is ignored.
func TestPlanRepoLinksBasedOnToExistingDoneMissions(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	repoPath := t.TempDir()
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: repoPath, Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "old_research", RepositoryID: "repo_1", Kind: domain.MissionKindResearch, Text: "how does auth work?", Status: domain.MissionStatusVerified},
			{ID: "old_draft", RepositoryID: "repo_1", Kind: domain.MissionKindTask, Text: "some unfinished idea", Status: domain.MissionStatusDraft},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	svc := NewService(jsonStore)
	var gotGraphContext string
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		gotGraphContext = graphContext
		return PlanResult{
			Content: "# Plan\nWire the new endpoint into auth.",
			Subtasks: []ProposedSubtask{
				{Title: "wire endpoint", Text: "wire the new endpoint using the auth findings", BasedOn: []int{1, 2}},
			},
		}, nil
	})

	plan, err := svc.PlanRepo(context.Background(), "repo_1", "add an endpoint", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}
	if !strings.Contains(gotGraphContext, "N1 [research · done] how does auth work?") {
		t.Fatalf("planner did not receive the graph index: %q", gotGraphContext)
	}

	// The basedOn resolution snapshot (LinkableIDs) is captured at plan time so
	// approval — which can happen later — still resolves it correctly.
	_, tasks, err := svc.ApprovePlan(plan.ID)
	if err != nil {
		t.Fatalf("ApprovePlan() error = %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("tasks = %d, want 1", len(tasks))
	}
	if len(tasks[0].DependsOn) != 1 || tasks[0].DependsOn[0] != "old_research" {
		t.Fatalf("DependsOn = %v, want [old_research] (draft node must be ignored)", tasks[0].DependsOn)
	}
}

// A prose reply (no JSON contract) triggers exactly one repair call; when the
// repair reply parses, its plan/subtasks are used instead of the goal-fallback
// salvage.
func TestPlanWithRepairFixesProseReplyOnSuccessfulRepair(t *testing.T) {
	calls := 0
	query := func(ctx context.Context, repoPath, model, prompt string, onStep func(kind, text string)) (string, error) {
		calls++
		if calls == 1 {
			return "Sure, here's how I'd approach it: first add the parser, then wire the CLI.", nil
		}
		return `{"plan":"# Plan\n1. Add parser\n2. Wire CLI","subtasks":[{"title":"parser","text":"add parse_config"},{"title":"cli","text":"wire it up"}]}`, nil
	}

	var steps []string
	onStep := func(kind, text string) { steps = append(steps, text) }

	result, err := planWithRepair(context.Background(), query, "model", "/repo", "make it loadable", domain.PlanFormatMarkdown, "", onStep)
	if err != nil {
		t.Fatalf("planWithRepair() error = %v", err)
	}
	if calls != 2 {
		t.Fatalf("query calls = %d, want 2 (plan + repair)", calls)
	}
	if result.Content != "# Plan\n1. Add parser\n2. Wire CLI" || len(result.Subtasks) != 2 {
		t.Fatalf("result = %+v, want repaired plan/subtasks", result)
	}
	found := false
	for _, s := range steps {
		if strings.Contains(s, "repairing plan output") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a step announcing the repair, got %v", steps)
	}
}

// When the repair call itself still doesn't produce parseable JSON, today's
// prose-salvage behavior is unchanged: the prose becomes the plan document
// with no subtasks.
func TestPlanWithRepairFallsBackToSalvageOnFailedRepair(t *testing.T) {
	calls := 0
	prose := "Sure, here's how I'd approach it: first add the parser, then wire the CLI."
	query := func(ctx context.Context, repoPath, model, prompt string, onStep func(kind, text string)) (string, error) {
		calls++
		if calls == 1 {
			return prose, nil
		}
		return "Sorry, still not JSON.", nil
	}

	result, err := planWithRepair(context.Background(), query, "model", "/repo", "make it loadable", domain.PlanFormatMarkdown, "", func(string, string) {})
	if err != nil {
		t.Fatalf("planWithRepair() error = %v", err)
	}
	if calls != 2 {
		t.Fatalf("query calls = %d, want 2 (plan + repair attempt)", calls)
	}
	if result.Content != prose || len(result.Subtasks) != 0 {
		t.Fatalf("result = %+v, want prose salvage with no subtasks", result)
	}
}

// A reply that already carries the JSON contract with subtasks never triggers
// a repair call.
func TestPlanWithRepairSkipsRepairWhenSubtasksPresent(t *testing.T) {
	calls := 0
	query := func(ctx context.Context, repoPath, model, prompt string, onStep func(kind, text string)) (string, error) {
		calls++
		return `{"plan":"# Plan","subtasks":[{"title":"a","text":"do a"}]}`, nil
	}

	result, err := planWithRepair(context.Background(), query, "model", "/repo", "goal", domain.PlanFormatMarkdown, "", func(string, string) {})
	if err != nil {
		t.Fatalf("planWithRepair() error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("query calls = %d, want 1 (no repair)", calls)
	}
	if result.Content != "# Plan" || len(result.Subtasks) != 1 {
		t.Fatalf("result = %+v", result)
	}
}

func TestParsePlanResultToleratesFences(t *testing.T) {
	result, err := parsePlanResult("```json\n{\"plan\":\"<h1>Plan</h1>\",\"subtasks\":[{\"title\":\"a\",\"text\":\"do a\"}]}\n```")
	if err != nil {
		t.Fatalf("parsePlanResult() error = %v", err)
	}
	if result.Content != "<h1>Plan</h1>" || len(result.Subtasks) != 1 {
		t.Fatalf("parsed = %+v", result)
	}

	atomic, err := parsePlanResult(`{"atomic": true}`)
	if err != nil {
		t.Fatalf("parsePlanResult(atomic) error = %v", err)
	}
	if atomic.Content != "" || len(atomic.Subtasks) != 0 {
		t.Fatalf("atomic parse = %+v, want empty result", atomic)
	}
}

func TestParsePlanResultSalvagesProse(t *testing.T) {
	prose := "Based on the research, the plan is:\n1. Do the thing."
	result, err := parsePlanResult(prose)
	if err != nil {
		t.Fatalf("parsePlanResult(prose) error = %v", err)
	}
	if result.Content != prose || len(result.Subtasks) != 0 {
		t.Fatalf("prose salvage = %+v, want the prose as content with no subtasks", result)
	}

	if _, err := parsePlanResult("   "); err == nil {
		t.Fatal("parsePlanResult(blank) should still fail")
	}
}

// Approving a plan materializes its proposed tasks as draft missions linked
// back by PlanID and chained by their proposed dependencies, and stamps
// ApprovedAt. A second approval errors — a plan materializes its tasks once.
func TestApprovePlanCreatesLinkedMissionsAndRejectsSecondApproval(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{
			Content: "# Plan\n1. Add parser\n2. Wire CLI",
			Subtasks: []ProposedSubtask{
				{Title: "parser", Text: "add parse_config in config.py"},
				{Title: "cli", Text: "use parse_config in cli.py", DependsOn: []int{0}},
			},
		}, nil
	})

	plan, err := svc.PlanRepo(context.Background(), "repo_1", "make the config loadable", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}

	approved, tasks, err := svc.ApprovePlan(plan.ID)
	if err != nil {
		t.Fatalf("ApprovePlan() error = %v", err)
	}
	if approved.ApprovedAt == nil {
		t.Fatal("expected ApprovedAt to be set")
	}
	if len(tasks) != 2 {
		t.Fatalf("materialized tasks = %d, want 2", len(tasks))
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.Missions) != 2 {
		t.Fatalf("expected 2 missions persisted, got %d", len(state.Missions))
	}
	var parser, cli domain.Mission
	for _, m := range state.Missions {
		if m.PlanID != plan.ID {
			t.Fatalf("task %s not linked to plan", m.ID)
		}
		if m.Status != domain.MissionStatusDraft {
			t.Fatalf("task %s should be a draft, got %s", m.ID, m.Status)
		}
		switch m.Text {
		case "add parse_config in config.py":
			parser = m
		case "use parse_config in cli.py":
			cli = m
		}
	}
	if parser.ID == "" || cli.ID == "" {
		t.Fatal("expected both tasks present")
	}
	if len(cli.DependsOn) != 1 || cli.DependsOn[0] != parser.ID {
		t.Fatalf("cli.DependsOn = %v, want [%s]", cli.DependsOn, parser.ID)
	}

	if _, _, err := svc.ApprovePlan(plan.ID); err == nil {
		t.Fatal("ApprovePlan() a second time should error")
	}
}

func TestApprovePlanRejectsUnknownPlanAndEmptySubtasks(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)

	if _, _, err := svc.ApprovePlan("nope"); err == nil {
		t.Fatal("ApprovePlan() with unknown plan should error")
	}

	now := time.Now().UTC()
	if _, err := jsonStore.Update(func(state *store.State) error {
		state.Plans = append(state.Plans, domain.Plan{ID: "plan_empty", RepositoryID: "repo_1", CreatedAt: now})
		return nil
	}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if _, _, err := svc.ApprovePlan("plan_empty"); err == nil {
		t.Fatal("ApprovePlan() with no subtasks should error")
	}
}

// Deleting an unapproved plan removes it; deleting an already-approved plan
// errors — its tasks already exist as missions, so its history is kept.
func TestDeletePlanRemovesUnapprovedAndRejectsApproved(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, graphContext string, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{Content: "# Plan", Subtasks: []ProposedSubtask{{Text: "do it"}}}, nil
	})

	plan, err := svc.PlanRepo(context.Background(), "repo_1", "goal", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}

	if err := svc.DeletePlan(plan.ID); err != nil {
		t.Fatalf("DeletePlan() error = %v", err)
	}
	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.Plans) != 0 {
		t.Fatalf("expected plan removed, got %+v", state.Plans)
	}

	plan2, err := svc.PlanRepo(context.Background(), "repo_1", "goal", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}
	if _, _, err := svc.ApprovePlan(plan2.ID); err != nil {
		t.Fatalf("ApprovePlan() error = %v", err)
	}
	if err := svc.DeletePlan(plan2.ID); err == nil {
		t.Fatal("DeletePlan() on an approved plan should error")
	}
}
