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

	mission, err := svc.CreateMission("repo_1", " add a version command ", " camp_1 ", "")
	if err != nil {
		t.Fatalf("CreateMission() error = %v", err)
	}

	if mission.RepositoryID != "repo_1" {
		t.Fatalf("repository ID = %q, want %q", mission.RepositoryID, "repo_1")
	}

	if mission.CampaignID != "camp_1" {
		t.Fatalf("campaign ID = %q, want %q", mission.CampaignID, "camp_1")
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

func TestCreateToolMissionSavesKindAndCommand(t *testing.T) {
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

	mission, err := svc.CreateToolMission("repo_1", "run tests", " go test ./... ", "")
	if err != nil {
		t.Fatalf("CreateToolMission() error = %v", err)
	}

	if mission.Kind != domain.MissionKindTool {
		t.Fatalf("mission kind = %q, want %q", mission.Kind, domain.MissionKindTool)
	}

	if mission.ToolCommand != "go test ./..." {
		t.Fatalf("tool command = %q, want %q", mission.ToolCommand, "go test ./...")
	}

	if !mission.IsTool() {
		t.Fatal("IsTool() = false, want true")
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(got.Missions) != 1 || got.Missions[0].ToolCommand != "go test ./..." {
		t.Fatalf("persisted missions = %+v, want one tool mission", got.Missions)
	}
}

func TestCreateToolMissionRejectsBlankCommand(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.CreateToolMission("repo_1", "run tests", "   ", ""); err == nil {
		t.Fatal("expected error for blank tool command, got nil")
	}
}

func TestCreateMissionRejectsBlankText(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.CreateMission("repo_1", "   ", "", ""); err == nil {
		t.Fatal("expected error for blank mission text, got nil")
	}
}

func TestCreateMissionRejectsUnknownRepository(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.CreateMission("missing_repo", "add a version command", "", ""); err == nil {
		t.Fatal("expected error for unknown repository, got nil")
	}
}

// The model chosen when a task is created must be persisted on the mission —
// it is a decision, and a reload must not silently swap it for whatever the
// global picker happens to say.
func TestCreateMissionPersistsTheChosenModel(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	if _, err := svc.OpenRepository(t.TempDir()); err != nil {
		t.Fatalf("OpenRepository() error = %v", err)
	}
	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	repoID := state.Repositories[0].ID

	mission, err := svc.CreateMission(repoID, "add a version command", "", " claude-haiku-4-5 ")
	if err != nil {
		t.Fatalf("CreateMission() error = %v", err)
	}
	if mission.Model != "claude-haiku-4-5" {
		t.Errorf("Model = %q, want the trimmed chosen model", mission.Model)
	}

	// No choice made is not a choice of "": the run falls through to the picker.
	plain, err := svc.CreateMission(repoID, "another task", "", "")
	if err != nil {
		t.Fatalf("CreateMission() error = %v", err)
	}
	if plain.Model != "" {
		t.Errorf("Model = %q, want empty when no model was chosen", plain.Model)
	}
}
