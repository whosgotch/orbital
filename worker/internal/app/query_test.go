package app

import (
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestScopedQueriesReturnMatchingRecords(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{ID: "repo_1", Name: "demo"},
			{ID: "repo_2", Name: "other"},
		},
		Missions: []domain.Mission{
			{ID: "mission_1", RepositoryID: "repo_1"},
			{ID: "mission_2", RepositoryID: "repo_2"},
		},
		AgentRuns: []domain.AgentRun{
			{ID: "run_1", MissionID: "mission_1"},
			{ID: "run_2", MissionID: "mission_2"},
		},
		WorkflowEvents: []domain.WorkflowEvent{
			{ID: "event_1", MissionID: "mission_1", RunID: "run_1"},
			{ID: "event_2", MissionID: "mission_2", RunID: "run_2"},
		},
		PatchProposals: []domain.PatchProposal{
			{ID: "patch_1", RunID: "run_1"},
			{ID: "patch_2", RunID: "run_2"},
		},
		VerificationRuns: []domain.VerificationRun{
			{ID: "verification_1", MissionID: "mission_1"},
			{ID: "verification_2", MissionID: "mission_2"},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	repositories, err := svc.ListRepositories()
	if err != nil {
		t.Fatalf("ListRepositories() error = %v", err)
	}
	if len(repositories) != 2 || repositories[0].ID != "repo_1" || repositories[1].ID != "repo_2" {
		t.Fatalf("repositories = %+v, want repo_1 and repo_2", repositories)
	}

	missions, err := svc.ListMissionsByRepository("repo_1")
	if err != nil {
		t.Fatalf("ListMissionsByRepository() error = %v", err)
	}
	if len(missions) != 1 || missions[0].ID != "mission_1" {
		t.Fatalf("missions = %+v, want only mission_1", missions)
	}

	runs, err := svc.ListRunsByMission("mission_1")
	if err != nil {
		t.Fatalf("ListRunsByMission() error = %v", err)
	}
	if len(runs) != 1 || runs[0].ID != "run_1" {
		t.Fatalf("runs = %+v, want only run_1", runs)
	}

	events, err := svc.ListEventsByRun("run_1")
	if err != nil {
		t.Fatalf("ListEventsByRun() error = %v", err)
	}
	if len(events) != 1 || events[0].ID != "event_1" {
		t.Fatalf("events = %+v, want only event_1", events)
	}

	missionEvents, err := svc.ListEventsByMission("mission_1")
	if err != nil {
		t.Fatalf("ListEventsByMission() error = %v", err)
	}
	if len(missionEvents) != 1 || missionEvents[0].ID != "event_1" {
		t.Fatalf("mission events = %+v, want only event_1", missionEvents)
	}

	patches, err := svc.ListPatchesByRun("run_1")
	if err != nil {
		t.Fatalf("ListPatchesByRun() error = %v", err)
	}
	if len(patches) != 1 || patches[0].ID != "patch_1" {
		t.Fatalf("patches = %+v, want only patch_1", patches)
	}

	verifications, err := svc.ListVerificationsByMission("mission_1")
	if err != nil {
		t.Fatalf("ListVerificationsByMission() error = %v", err)
	}
	if len(verifications) != 1 || verifications[0].ID != "verification_1" {
		t.Fatalf("verifications = %+v, want only verification_1", verifications)
	}
}

func TestLoadStateWithLiveBranchesRefreshesFromDisk(t *testing.T) {
	repoDir := initGitRepository(t)
	runGit(t, repoDir, "checkout", "-b", "feature/live-branch")

	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{ID: "repo_1", Path: repoDir, Name: "demo", Branch: "main"},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	svc := NewService(jsonStore)

	state, err := svc.LoadStateWithLiveBranches()
	if err != nil {
		t.Fatalf("LoadStateWithLiveBranches() error = %v", err)
	}

	if state.Repositories[0].Branch != "feature/live-branch" {
		t.Fatalf("branch = %q, want %q", state.Repositories[0].Branch, "feature/live-branch")
	}

	persisted, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if persisted.Repositories[0].Branch != "main" {
		t.Fatalf("persisted branch = %q, want unchanged %q", persisted.Repositories[0].Branch, "main")
	}
}

func TestLoadStateWithLiveBranchesKeepsStoredBranchForNonGitPath(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{ID: "repo_1", Path: t.TempDir(), Name: "demo", Branch: "main"},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	svc := NewService(jsonStore)

	state, err := svc.LoadStateWithLiveBranches()
	if err != nil {
		t.Fatalf("LoadStateWithLiveBranches() error = %v", err)
	}

	if state.Repositories[0].Branch != "main" {
		t.Fatalf("branch = %q, want unchanged %q", state.Repositories[0].Branch, "main")
	}
}
