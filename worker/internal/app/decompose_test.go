package app

import (
	"context"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func decomposeState(t *testing.T) *store.JSONStore {
	t.Helper()
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions: []domain.Mission{{
			ID:           "mission_1",
			RepositoryID: "repo_1",
			Text:         "add config parsing and wire it into the CLI",
			Status:       domain.MissionStatusDraft,
		}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	return jsonStore
}

func splitDecomposer(ctx context.Context, model, repoPath, text string) (PlanResult, error) {
	return PlanResult{
		Content: "## Split\nparser first, then the CLI uses it.",
		Subtasks: []ProposedSubtask{
			{Title: "parser", Text: "add parse_config in config.py"},
			{Title: "cli", Text: "use parse_config in cli.py", DependsOn: []int{0}},
		},
	}, nil
}

// When the planner returns sub-tasks, the umbrella node is replaced by a plan
// node fanning out to them: draft nodes in the same repo, with the proposed
// dependency chain carried over and the plan recorded.
func TestDecomposeMissionReplacesNodeWithPlanAndChainedSubtasks(t *testing.T) {
	jsonStore := decomposeState(t)
	svc := NewService(jsonStore)
	svc.SetDecomposer(splitDecomposer)

	created, err := svc.DecomposeMission(context.Background(), "mission_1")
	if err != nil {
		t.Fatalf("DecomposeMission() error = %v", err)
	}
	if len(created) != 2 {
		t.Fatalf("created sub-tasks = %d, want 2", len(created))
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if findMissionIndex(state.Missions, "mission_1") != -1 {
		t.Fatal("original mission should be replaced, but it still exists")
	}
	if len(state.Missions) != 2 {
		t.Fatalf("missions after split = %d, want 2", len(state.Missions))
	}

	// The split is anchored by a plan holding the written rationale, with the
	// umbrella's text as its goal, and every sub-task links back to it.
	if len(state.Plans) != 1 {
		t.Fatalf("plans after split = %d, want 1", len(state.Plans))
	}
	plan := state.Plans[0]
	if plan.Goal != "add config parsing and wire it into the CLI" {
		t.Fatalf("plan.Goal = %q, want the umbrella text", plan.Goal)
	}
	if plan.Format != domain.PlanFormatMarkdown || plan.Content == "" {
		t.Fatalf("plan should hold a Markdown document, got format=%q content=%q", plan.Format, plan.Content)
	}

	// The second sub-task waits on the first, and both are editable drafts.
	var parser, cli domain.Mission
	for _, m := range state.Missions {
		switch m.Text {
		case "add parse_config in config.py":
			parser = m
		case "use parse_config in cli.py":
			cli = m
		}
	}
	if parser.ID == "" || cli.ID == "" {
		t.Fatalf("sub-tasks missing: parser=%q cli=%q", parser.ID, cli.ID)
	}
	if parser.PlanID != plan.ID || cli.PlanID != plan.ID {
		t.Fatalf("sub-tasks should link to the plan, got %q and %q", parser.PlanID, cli.PlanID)
	}
	if parser.Status != domain.MissionStatusDraft || cli.Status != domain.MissionStatusDraft {
		t.Fatal("sub-tasks should be draft nodes")
	}
	if len(cli.DependsOn) != 1 || cli.DependsOn[0] != parser.ID {
		t.Fatalf("cli.DependsOn = %v, want [%s]", cli.DependsOn, parser.ID)
	}
	if len(parser.DependsOn) != 0 {
		t.Fatalf("parser should have no deps, got %v", parser.DependsOn)
	}
}

// Splitting a task in the middle of a chain must not orphan its neighbors:
// root sub-tasks inherit the umbrella's upstream deps, and a task that waited
// on the umbrella now waits on its terminal sub-tasks.
func TestDecomposeMissionRewiresDependencies(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "mission_up", RepositoryID: "repo_1", Text: "upstream", Status: domain.MissionStatusDraft},
			{ID: "mission_1", RepositoryID: "repo_1", Text: "middle", Status: domain.MissionStatusDraft, DependsOn: []string{"mission_up"}},
			{ID: "mission_down", RepositoryID: "repo_1", Text: "downstream", Status: domain.MissionStatusDraft, DependsOn: []string{"mission_1"}},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	svc := NewService(jsonStore)
	svc.SetDecomposer(splitDecomposer)

	if _, err := svc.DecomposeMission(context.Background(), "mission_1"); err != nil {
		t.Fatalf("DecomposeMission() error = %v", err)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	var parser, cli, down domain.Mission
	for _, m := range state.Missions {
		switch m.Text {
		case "add parse_config in config.py":
			parser = m
		case "use parse_config in cli.py":
			cli = m
		case "downstream":
			down = m
		}
	}
	if len(parser.DependsOn) != 1 || parser.DependsOn[0] != "mission_up" {
		t.Fatalf("root sub-task should inherit upstream deps, got %v", parser.DependsOn)
	}
	if len(cli.DependsOn) != 1 || cli.DependsOn[0] != parser.ID {
		t.Fatalf("chained sub-task should keep sibling dep only, got %v", cli.DependsOn)
	}
	if len(down.DependsOn) != 1 || down.DependsOn[0] != cli.ID {
		t.Fatalf("downstream should wait on the terminal sub-task, got %v", down.DependsOn)
	}
}

// A coherent task must be left untouched: the planner returns nothing to
// split, so the node stays exactly as it was and no plan is recorded.
func TestDecomposeMissionLeavesAtomicTaskUnchanged(t *testing.T) {
	jsonStore := decomposeState(t)
	svc := NewService(jsonStore)
	svc.SetDecomposer(func(ctx context.Context, model, repoPath, text string) (PlanResult, error) {
		return PlanResult{}, nil
	})

	created, err := svc.DecomposeMission(context.Background(), "mission_1")
	if err != nil {
		t.Fatalf("DecomposeMission() error = %v", err)
	}
	if created != nil {
		t.Fatalf("created = %v, want nil for an atomic task", created)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.Missions) != 1 || state.Missions[0].ID != "mission_1" {
		t.Fatalf("atomic task should be unchanged, got %+v", state.Missions)
	}
	if len(state.Plans) != 0 {
		t.Fatalf("atomic task should record no plan, got %+v", state.Plans)
	}
}

func TestDecomposeMissionRejectsNonDraft(t *testing.T) {
	jsonStore := decomposeState(t)
	svc := NewService(jsonStore)
	svc.SetDecomposer(splitDecomposer)

	// Flip the mission to running: a live task must not be split under the agent.
	state, _ := jsonStore.Load()
	state.Missions[0].Status = domain.MissionStatusRunning
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.DecomposeMission(context.Background(), "mission_1"); err == nil {
		t.Fatal("DecomposeMission() on a running task should error")
	}
}
