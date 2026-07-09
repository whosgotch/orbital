package app

import (
	"context"
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
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat) (PlanResult, error) {
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

// An unknown format falls back to markdown rather than storing something the UI
// can't render.
func TestPlanRepoNormalizesUnknownFormat(t *testing.T) {
	jsonStore := planState(t)
	svc := NewService(jsonStore)
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat) (PlanResult, error) {
		if format != domain.PlanFormatMarkdown {
			t.Fatalf("planner got format %q, want normalized md", format)
		}
		return PlanResult{Content: "plan", Subtasks: nil}, nil
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
	svc.SetPlanner(func(ctx context.Context, model, repoPath, goal string, format domain.PlanFormat) (PlanResult, error) {
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
}
