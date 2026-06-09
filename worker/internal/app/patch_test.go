package app

import (
	"os"
	"path/filepath"
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

	assertLastWorkflowEvent(t, got.WorkflowEvents, domain.WorkflowEventPatchApproved, "mission_1", "run_1")
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

	assertLastWorkflowEvent(t, got.WorkflowEvents, domain.WorkflowEventPatchRejected, "mission_1", "run_1")
}

func TestPatchDecisionRejectsUnknownPatch(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.ApprovePatch("missing_patch"); err == nil {
		t.Fatal("expected error for unknown patch, got nil")
	}
}

func TestApplyPatchAppliesApprovedPatchAndMarksApplied(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()
	filePath := filepath.Join(repoDir, "file.txt")
	createdAt := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)

	if err := os.WriteFile(filePath, []byte("before\n"), 0644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	if err := jsonStore.Save(patchApplyState(repoDir, domain.PatchStatusApproved, createdAt)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	patch, err := svc.ApplyPatch("patch_1")
	if err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}

	if patch.Status != domain.PatchStatusApplied {
		t.Fatalf("patch status = %q, want %q", patch.Status, domain.PatchStatusApplied)
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Missions[0].Status != domain.MissionStatusApplied {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusApplied)
	}

	assertLastWorkflowEvent(t, got.WorkflowEvents, domain.WorkflowEventPatchApplied, "mission_1", "run_1")

	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}

	if string(content) != "after\n" {
		t.Fatalf("file content = %q, want %q", string(content), "after\n")
	}
}

func TestApplyPatchRejectsPendingPatch(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()
	createdAt := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)

	if err := jsonStore.Save(patchApplyState(repoDir, domain.PatchStatusPending, createdAt)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.ApplyPatch("patch_1"); err == nil {
		t.Fatal("expected error for pending patch, got nil")
	}
}

func TestApplyPatchRejectsUnknownPatch(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.ApplyPatch("missing_patch"); err == nil {
		t.Fatal("expected error for unknown patch, got nil")
	}
}

func assertLastWorkflowEvent(t *testing.T, events []domain.WorkflowEvent, wantType domain.WorkflowEventType, wantMissionID string, wantRunID string) {
	t.Helper()

	if len(events) == 0 {
		t.Fatal("expected workflow event, got none")
	}

	event := events[len(events)-1]
	if event.Type != wantType {
		t.Fatalf("event type = %q, want %q", event.Type, wantType)
	}

	if event.MissionID != wantMissionID {
		t.Fatalf("event mission ID = %q, want %q", event.MissionID, wantMissionID)
	}

	if event.RunID != wantRunID {
		t.Fatalf("event run ID = %q, want %q", event.RunID, wantRunID)
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

func patchApplyState(repoPath string, patchStatus domain.PatchStatus, createdAt time.Time) *store.State {
	state := patchDecisionState(createdAt)
	state.Repositories = []domain.Repository{
		{
			ID:        "repo_1",
			Path:      repoPath,
			Name:      "demo",
			CreatedAt: createdAt,
		},
	}
	state.PatchProposals[0].Status = patchStatus
	state.PatchProposals[0].Diff = `diff --git a/file.txt b/file.txt
index 8b13789..3b18e51 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-before
+after
`

	return state
}
