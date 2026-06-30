package app

import (
	"context"
	"errors"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func planTestService(t *testing.T, decompose decomposeFunc) (*Service, *store.JSONStore) {
	t.Helper()
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: "/tmp/demo", Name: "demo"}},
		Missions:     []domain.Mission{{ID: "mission_1", RepositoryID: "repo_1", Text: "ship a health endpoint", Status: domain.MissionStatusDraft}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	svc := NewService(jsonStore)
	svc.decompose = decompose
	return svc, jsonStore
}

func TestPlanMissionCreatesChildMissions(t *testing.T) {
	svc, jsonStore := planTestService(t, func(ctx context.Context, repoPath, mission string) ([]agent.SubTask, error) {
		if repoPath != "/tmp/demo" {
			t.Errorf("repoPath = %q, want /tmp/demo", repoPath)
		}
		return []agent.SubTask{
			{Title: "Add route", Prompt: "Add a GET /health route"},
			{Title: "Add tests", Prompt: "Cover the route with a test"},
		}, nil
	})

	children, err := svc.PlanMission(context.Background(), "mission_1")
	if err != nil {
		t.Fatalf("PlanMission() error = %v", err)
	}
	if len(children) != 2 {
		t.Fatalf("got %d children, want 2", len(children))
	}
	for _, child := range children {
		if child.ParentMissionID != "mission_1" {
			t.Errorf("child %s parent = %q, want mission_1", child.ID, child.ParentMissionID)
		}
		if child.RepositoryID != "repo_1" {
			t.Errorf("child %s repo = %q, want repo_1", child.ID, child.RepositoryID)
		}
		if child.Status != domain.MissionStatusDraft {
			t.Errorf("child %s status = %q, want draft", child.ID, child.Status)
		}
	}
	if children[0].Title != "Add route" || children[0].Text != "Add a GET /health route" {
		t.Errorf("child 0 = %+v", children[0])
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.Missions) != 3 {
		t.Fatalf("expected 3 missions persisted, got %d", len(state.Missions))
	}
}

func TestPlanMissionFallsBackOnDecomposeError(t *testing.T) {
	svc, _ := planTestService(t, func(ctx context.Context, repoPath, mission string) ([]agent.SubTask, error) {
		return nil, errors.New("claude CLI not found")
	})

	children, err := svc.PlanMission(context.Background(), "mission_1")
	if err != nil {
		t.Fatalf("PlanMission() error = %v", err)
	}
	if len(children) != 1 {
		t.Fatalf("expected single fallback sub-task, got %d", len(children))
	}
	if children[0].Text != "ship a health endpoint" {
		t.Errorf("fallback text = %q, want the outcome", children[0].Text)
	}
}

func TestUpdateMissionText(t *testing.T) {
	svc, jsonStore := planTestService(t, nil)

	updated, err := svc.UpdateMissionText("mission_1", "  rewritten prompt  ")
	if err != nil {
		t.Fatalf("UpdateMissionText() error = %v", err)
	}
	if updated.Text != "rewritten prompt" {
		t.Fatalf("text = %q, want trimmed", updated.Text)
	}

	state, _ := jsonStore.Load()
	if state.Missions[0].Text != "rewritten prompt" {
		t.Fatalf("persisted text = %q", state.Missions[0].Text)
	}

	if _, err := svc.UpdateMissionText("mission_1", "   "); err == nil {
		t.Fatal("expected error for blank text")
	}
	if _, err := svc.UpdateMissionText("missing", "x"); err == nil {
		t.Fatal("expected error for unknown mission")
	}
}

func TestUpdateMissionTextRejectsRunning(t *testing.T) {
	svc, jsonStore := planTestService(t, nil)
	state, _ := jsonStore.Load()
	state.Missions[0].Status = domain.MissionStatusRunning
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if _, err := svc.UpdateMissionText("mission_1", "new"); err == nil {
		t.Fatal("expected error editing a running mission")
	}
}

func TestPlanMissionRejectsUnknownMission(t *testing.T) {
	svc, _ := planTestService(t, func(ctx context.Context, repoPath, mission string) ([]agent.SubTask, error) {
		return []agent.SubTask{{Title: "x", Prompt: "x"}}, nil
	})
	if _, err := svc.PlanMission(context.Background(), "nope"); err == nil {
		t.Fatal("expected error for unknown mission")
	}
}
