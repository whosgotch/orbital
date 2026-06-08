package app

import (
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestCreateMissionSavesMission(t *testing.T) {
	stateDir := t.TempDir()
	jsonStore := store.NewJSONStore(stateDir)
	svc := NewService(jsonStore)

	state := &store.State{
		Repositories: []domain.Repository{
			{
				ID:   "repo_1",
				Path: "/tmp/demo",
				Name: "demo",
			},
		},
	}

	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	mission, err := svc.CreateMission("repo_1", " add a version command ")
	if err != nil {
		t.Fatalf("CreateMission() error = %v", err)
	}

	if mission.RepositoryID != "repo_1" {
		t.Fatalf("repository ID = %q, want %q", mission.RepositoryID, "repo_1")
	}

	if mission.Text != "add a version command" {
		t.Fatalf("mission text = %q, want %q", mission.Text, "add a version command")
	}

	if mission.Status != domain.MissionStatusDraft {
		t.Fatalf("mission status = %q, want %q", mission.Status, domain.MissionStatusDraft)
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(got.Missions) != 1 {
		t.Fatalf("expected 1 mission, got %d", len(got.Missions))
	}
}

func TestCreateMissionRejectsBlankText(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.CreateMission("repo_1", "   "); err == nil {
		t.Fatal("expected error for blank mission text, got nil")
	}
}

func TestCreateMissionRejectsUnknownRepository(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.CreateMission("missing_repo", "add a version command"); err == nil {
		t.Fatal("expected error for unknown repository, got nil")
	}
}
