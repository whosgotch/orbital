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

// When the decomposer returns sub-tasks, the umbrella node is replaced by them:
// draft nodes in the same repo, with the proposed dependency chain carried over.
func TestDecomposeMissionReplacesNodeWithChainedSubtasks(t *testing.T) {
	jsonStore := decomposeState(t)
	svc := NewService(jsonStore)
	svc.SetDecomposer(func(ctx context.Context, model, text string) ([]ProposedSubtask, error) {
		return []ProposedSubtask{
			{Title: "parser", Text: "add parse_config in config.py"},
			{Title: "cli", Text: "use parse_config in cli.py", DependsOn: []int{0}},
		}, nil
	})

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

// A coherent task must be left untouched: the decomposer returns nothing to
// split, so the node stays exactly as it was.
func TestDecomposeMissionLeavesAtomicTaskUnchanged(t *testing.T) {
	jsonStore := decomposeState(t)
	svc := NewService(jsonStore)
	svc.SetDecomposer(func(ctx context.Context, model, text string) ([]ProposedSubtask, error) {
		return nil, nil
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
}

func TestDecomposeMissionRejectsNonDraft(t *testing.T) {
	jsonStore := decomposeState(t)
	svc := NewService(jsonStore)
	svc.SetDecomposer(func(ctx context.Context, model, text string) ([]ProposedSubtask, error) {
		return []ProposedSubtask{{Text: "a"}, {Text: "b"}}, nil
	})

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

func TestParseDecompositionToleratesFencesAndProse(t *testing.T) {
	subtasks, err := parseDecomposition("Here you go:\n```json\n{\"subtasks\":[{\"title\":\"a\",\"text\":\"do a\"},{\"title\":\"b\",\"text\":\"do b\",\"dependsOn\":[0]}]}\n```")
	if err != nil {
		t.Fatalf("parseDecomposition() error = %v", err)
	}
	if len(subtasks) != 2 || subtasks[1].DependsOn[0] != 0 {
		t.Fatalf("parsed = %+v, want two chained sub-tasks", subtasks)
	}

	atomic, err := parseDecomposition(`{"atomic": true}`)
	if err != nil {
		t.Fatalf("parseDecomposition(atomic) error = %v", err)
	}
	if atomic != nil {
		t.Fatalf("atomic parse = %v, want nil", atomic)
	}
}
