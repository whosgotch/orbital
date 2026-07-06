package app

import (
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func linkTestService(t *testing.T) (*Service, *store.JSONStore) {
	t.Helper()
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: "/tmp/demo", Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "mission_a", RepositoryID: "repo_1", Text: "extract the client", Status: domain.MissionStatusDraft},
			{ID: "mission_b", RepositoryID: "repo_1", Text: "add retries on top", Status: domain.MissionStatusDraft},
			{ID: "mission_c", RepositoryID: "repo_1", Text: "document the flow", Status: domain.MissionStatusDraft},
			{ID: "mission_tool", RepositoryID: "repo_1", Text: "run tests", Status: domain.MissionStatusDraft, Kind: domain.MissionKindTool, ToolCommand: "true"},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	return NewService(jsonStore), jsonStore
}

func dependsOf(t *testing.T, jsonStore *store.JSONStore, missionID string) []string {
	t.Helper()
	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	for _, mission := range state.Missions {
		if mission.ID == missionID {
			return mission.DependsOn
		}
	}
	t.Fatalf("mission not found: %s", missionID)
	return nil
}

func TestLinkMissionsRecordsDependency(t *testing.T) {
	svc, jsonStore := linkTestService(t)

	if err := svc.LinkMissions("mission_a", "mission_b"); err != nil {
		t.Fatalf("LinkMissions() error = %v", err)
	}
	if deps := dependsOf(t, jsonStore, "mission_b"); len(deps) != 1 || deps[0] != "mission_a" {
		t.Fatalf("depends_on = %v, want [mission_a]", deps)
	}

	// Idempotent: linking twice keeps a single entry.
	if err := svc.LinkMissions("mission_a", "mission_b"); err != nil {
		t.Fatalf("LinkMissions() repeat error = %v", err)
	}
	if deps := dependsOf(t, jsonStore, "mission_b"); len(deps) != 1 {
		t.Fatalf("depends_on after repeat = %v, want one entry", deps)
	}

	// Tool missions chain like any other mission.
	if err := svc.LinkMissions("mission_a", "mission_tool"); err != nil {
		t.Fatalf("LinkMissions(tool) error = %v", err)
	}
	if deps := dependsOf(t, jsonStore, "mission_tool"); len(deps) != 1 || deps[0] != "mission_a" {
		t.Fatalf("tool depends_on = %v, want [mission_a]", deps)
	}
}

func TestLinkMissionsRejectsCyclesAndUnknowns(t *testing.T) {
	svc, _ := linkTestService(t)

	if err := svc.LinkMissions("mission_a", "mission_a"); err == nil {
		t.Fatal("expected error for self-link")
	}
	if err := svc.LinkMissions("mission_a", "missing"); err == nil {
		t.Fatal("expected error for unknown downstream mission")
	}
	if err := svc.LinkMissions("missing", "mission_b"); err == nil {
		t.Fatal("expected error for unknown upstream mission")
	}

	// a → b → c, then closing the loop c → a must fail.
	if err := svc.LinkMissions("mission_a", "mission_b"); err != nil {
		t.Fatalf("LinkMissions(a→b) error = %v", err)
	}
	if err := svc.LinkMissions("mission_b", "mission_c"); err != nil {
		t.Fatalf("LinkMissions(b→c) error = %v", err)
	}
	if err := svc.LinkMissions("mission_c", "mission_a"); err == nil {
		t.Fatal("expected cycle error for c→a")
	}
}

func TestUnlinkMissionsRemovesDependency(t *testing.T) {
	svc, jsonStore := linkTestService(t)

	if err := svc.LinkMissions("mission_a", "mission_b"); err != nil {
		t.Fatalf("LinkMissions() error = %v", err)
	}
	if err := svc.UnlinkMissions("mission_a", "mission_b"); err != nil {
		t.Fatalf("UnlinkMissions() error = %v", err)
	}
	if deps := dependsOf(t, jsonStore, "mission_b"); deps != nil {
		t.Fatalf("depends_on = %v, want nil", deps)
	}

	// Unlinking something that isn't linked is a quiet no-op.
	if err := svc.UnlinkMissions("mission_c", "mission_b"); err != nil {
		t.Fatalf("UnlinkMissions() no-op error = %v", err)
	}
}

func TestDeleteMissionDropsDanglingLinks(t *testing.T) {
	svc, jsonStore := linkTestService(t)

	if err := svc.LinkMissions("mission_a", "mission_b"); err != nil {
		t.Fatalf("LinkMissions() error = %v", err)
	}
	if err := svc.DeleteMission("mission_a"); err != nil {
		t.Fatalf("DeleteMission() error = %v", err)
	}
	if deps := dependsOf(t, jsonStore, "mission_b"); deps != nil {
		t.Fatalf("depends_on after delete = %v, want nil", deps)
	}
}
