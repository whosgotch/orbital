package app

import (
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestDeleteMissionRemovesMissionAndDependents(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	state := &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: "/tmp/demo", Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "mission_doomed", RepositoryID: "repo_1"},
			{ID: "mission_keep", RepositoryID: "repo_1"},
		},
		AgentRuns: []domain.AgentRun{
			{ID: "run_doomed", MissionID: "mission_doomed"},
			{ID: "run_keep", MissionID: "mission_keep"},
		},
		PatchProposals: []domain.PatchProposal{
			{ID: "patch_doomed", RunID: "run_doomed"},
			{ID: "patch_keep", RunID: "run_keep"},
		},
		VerificationRuns: []domain.VerificationRun{
			{ID: "verify_doomed", MissionID: "mission_doomed", RepositoryID: "repo_1"},
			{ID: "verify_keep", MissionID: "mission_keep", RepositoryID: "repo_1"},
		},
		WorkflowEvents: []domain.WorkflowEvent{
			{ID: "event_by_mission", MissionID: "mission_doomed"},
			{ID: "event_by_run", RunID: "run_doomed"},
			{ID: "event_keep", MissionID: "mission_keep"},
		},
	}
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if err := svc.DeleteMission("mission_doomed"); err != nil {
		t.Fatalf("DeleteMission() error = %v", err)
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	assertOnlyID(t, "missions", len(got.Missions), idsOfMissions(got.Missions), "mission_keep")
	assertOnlyID(t, "agent runs", len(got.AgentRuns), idsOfRuns(got.AgentRuns), "run_keep")
	assertOnlyID(t, "patches", len(got.PatchProposals), idsOfPatches(got.PatchProposals), "patch_keep")
	assertOnlyID(t, "verifications", len(got.VerificationRuns), idsOfVerifications(got.VerificationRuns), "verify_keep")
	assertOnlyID(t, "events", len(got.WorkflowEvents), idsOfEvents(got.WorkflowEvents), "event_keep")
}

func TestDeleteMissionUnknownMission(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if err := svc.DeleteMission("missing"); err == nil {
		t.Fatal("expected error for unknown mission, got nil")
	}
}

func assertOnlyID(t *testing.T, label string, count int, ids []string, want string) {
	t.Helper()
	if count != 1 || len(ids) != 1 || ids[0] != want {
		t.Fatalf("%s = %v, want exactly [%s]", label, ids, want)
	}
}

func idsOfMissions(in []domain.Mission) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.ID
	}
	return out
}

func idsOfRuns(in []domain.AgentRun) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.ID
	}
	return out
}

func idsOfPatches(in []domain.PatchProposal) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.ID
	}
	return out
}

func idsOfVerifications(in []domain.VerificationRun) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.ID
	}
	return out
}

func idsOfEvents(in []domain.WorkflowEvent) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.ID
	}
	return out
}
