package app

import (
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestApprovePatchUpdatesPatchAndMission(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	createdAt := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)

	if err := jsonStore.Save(patchDecisionState(createdAt)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	patch, err := svc.ApprovePatch("patch_1")
	if err != nil {
		t.Fatalf("ApprovePatch() error = %v", err)
	}

	if patch.Status != domain.PatchStatusApproved {
		t.Fatalf("patch status = %q, want %q", patch.Status, domain.PatchStatusApproved)
	}

	if !patch.UpdatedAt.After(createdAt) {
		t.Fatalf("patch UpdatedAt = %v, want after %v", patch.UpdatedAt, createdAt)
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Missions[0].Status != domain.MissionStatusApproved {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusApproved)
	}
}

func TestRejectPatchUpdatesPatchAndMission(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	createdAt := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)

	if err := jsonStore.Save(patchDecisionState(createdAt)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	patch, err := svc.RejectPatch("patch_1")
	if err != nil {
		t.Fatalf("RejectPatch() error = %v", err)
	}

	if patch.Status != domain.PatchStatusRejected {
		t.Fatalf("patch status = %q, want %q", patch.Status, domain.PatchStatusRejected)
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Missions[0].Status != domain.MissionStatusRejected {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusRejected)
	}
}

func TestPatchDecisionRejectsUnknownPatch(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.ApprovePatch("missing_patch"); err == nil {
		t.Fatal("expected error for unknown patch, got nil")
	}
}

func patchDecisionState(createdAt time.Time) *store.State {
	return &store.State{
		Missions: []domain.Mission{
			{
				ID:           "mission_1",
				RepositoryID: "repo_1",
				Text:         "add a version command",
				Status:       domain.MissionStatusWaitingApproval,
				CreatedAt:    createdAt,
				UpdatedAt:    createdAt,
			},
		},
		AgentRuns: []domain.AgentRun{
			{
				ID:         "run_1",
				MissionID:  "mission_1",
				WorkerName: "mock",
				Status:     domain.AgentRunStatusCompleted,
				StartedAt:  createdAt,
			},
		},
		PatchProposals: []domain.PatchProposal{
			{
				ID:        "patch_1",
				RunID:     "run_1",
				Status:    domain.PatchStatusPending,
				Diff:      "diff --git a/file.txt b/file.txt",
				CreatedAt: createdAt,
				UpdatedAt: createdAt,
			},
		},
	}
}
