package app

import (
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func editTestService(t *testing.T) (*Service, *store.JSONStore) {
	t.Helper()
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: "/tmp/demo", Name: "demo"}},
		Missions:     []domain.Mission{{ID: "mission_1", RepositoryID: "repo_1", Text: "ship a health endpoint", Status: domain.MissionStatusDraft}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	return NewService(jsonStore), jsonStore
}

func TestUpdateMissionText(t *testing.T) {
	svc, jsonStore := editTestService(t)

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
	svc, jsonStore := editTestService(t)
	state, _ := jsonStore.Load()
	state.Missions[0].Status = domain.MissionStatusRunning
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if _, err := svc.UpdateMissionText("mission_1", "new"); err == nil {
		t.Fatal("expected error editing a running mission")
	}
}
