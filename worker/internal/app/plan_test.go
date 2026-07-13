package app

import (
	"bytes"
	"context"
	"strings"
	"testing"

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

// A planning pass records a plan node (holding the written document in the
// chosen format) and fans it out to draft task nodes that link back by PlanID
// and carry the proposed dependency chain.
func TestPlanRepoRecordsPlanAndFansOutTasks(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{
			Content: "# Plan\n1. Add parser\n2. Wire CLI",
			Subtasks: []ProposedSubtask{
				{Title: "parser", Text: "add parse_config in config.py"},
				{Title: "cli", Text: "use parse_config in cli.py", DependsOn: []int{0}},
			},
		}, nil
	})

	plan, tasks, err := svc.PlanRepo(context.Background(), "repo_1", "make the config loadable", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}
	if plan.Content == "" || plan.Format != domain.PlanFormatMarkdown || plan.Goal != "make the config loadable" {
		t.Fatalf("plan not recorded correctly: %+v", plan)
	}
	if len(tasks) != 2 {
		t.Fatalf("fanned-out tasks = %d, want 2", len(tasks))
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.Plans) != 1 || state.Plans[0].ID != plan.ID {
		t.Fatalf("plan not persisted: %+v", state.Plans)
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
}

// A plan that proposes no tasks still yields one: the goal itself becomes the
// single task, so planning never produces an empty fan-out.
func TestPlanRepoFallsBackToSingleTask(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{Content: "## Plan\nOne focused change."}, nil
	})

	plan, tasks, err := svc.PlanRepo(context.Background(), "repo_1", "fix the typo in README", domain.PlanFormatMarkdown)
	if err != nil {
		t.Fatalf("PlanRepo() error = %v", err)
	}
	if len(tasks) != 1 || tasks[0].Text != "fix the typo in README" {
		t.Fatalf("tasks = %+v, want one task carrying the goal", tasks)
	}
	if tasks[0].PlanID != plan.ID {
		t.Fatalf("fallback task not linked to plan")
	}
}

// Planner steps stream as EVENT: NDJSON lines on eventOut, and are ephemeral —
// none of them end up persisted in the state.
func TestPlanRepoStreamsStepsWithoutPersistingThem(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	var out bytes.Buffer
	svc.SetEventOut(&out)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, onStep func(kind, text string)) (PlanResult, error) {
		onStep("thought", "surveying the parser")
		onStep("action", "Read(config.py)")
		return PlanResult{Content: "plan", Subtasks: []ProposedSubtask{{Text: "do it"}}}, nil
	})

	if _, _, err := svc.PlanRepo(context.Background(), "repo_1", "goal", domain.PlanFormatMarkdown); err != nil {
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
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, onStep func(kind, text string)) (PlanResult, error) {
		if format != domain.PlanFormatMarkdown {
			t.Fatalf("planner got format %q, want normalized md", format)
		}
		return PlanResult{Content: "plan", Subtasks: []ProposedSubtask{{Text: "tidy"}}}, nil
	})

	plan, _, err := svc.PlanRepo(context.Background(), "repo_1", "", domain.PlanFormat("bogus"))
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
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat, onStep func(kind, text string)) (PlanResult, error) {
		return PlanResult{Content: "plan"}, nil
	})
	if _, _, err := svc.PlanRepo(context.Background(), "nope", "goal", domain.PlanFormatMarkdown); err == nil {
		t.Fatal("PlanRepo() with unknown repo should error")
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
