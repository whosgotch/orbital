package app

import (
	"context"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestRunVerificationPassesAndMarksMissionVerified(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()

	if err := jsonStore.Save(verificationState(repoDir)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	verification, err := svc.RunVerification(context.Background(), "repo_1", "mission_1", "printf verified")
	if err != nil {
		t.Fatalf("RunVerification() error = %v", err)
	}

	if verification.Status != domain.VerificationStatusPassed {
		t.Fatalf("verification status = %q, want %q", verification.Status, domain.VerificationStatusPassed)
	}

	if verification.ExitCode == nil || *verification.ExitCode != 0 {
		t.Fatalf("exit code = %v, want 0", verification.ExitCode)
	}

	if verification.Output != "verified" {
		t.Fatalf("output = %q, want %q", verification.Output, "verified")
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(got.VerificationRuns) != 1 {
		t.Fatalf("expected 1 verification run, got %d", len(got.VerificationRuns))
	}

	if got.Missions[0].Status != domain.MissionStatusVerified {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusVerified)
	}

	assertVerificationEvents(t, got.WorkflowEvents, domain.WorkflowEventVerificationPassed)
}

func TestRunVerificationFailureMarksMissionFailed(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()

	if err := jsonStore.Save(verificationState(repoDir)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	verification, err := svc.RunVerification(context.Background(), "repo_1", "mission_1", "printf failed && exit 7")
	if err != nil {
		t.Fatalf("RunVerification() error = %v", err)
	}

	if verification.Status != domain.VerificationStatusFailed {
		t.Fatalf("verification status = %q, want %q", verification.Status, domain.VerificationStatusFailed)
	}

	if verification.ExitCode == nil || *verification.ExitCode != 7 {
		t.Fatalf("exit code = %v, want 7", verification.ExitCode)
	}

	if verification.Output != "failed" {
		t.Fatalf("output = %q, want %q", verification.Output, "failed")
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Missions[0].Status != domain.MissionStatusFailed {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusFailed)
	}

	assertVerificationEvents(t, got.WorkflowEvents, domain.WorkflowEventVerificationFailed)
}

func TestRunVerificationStartupFailureMarksMissionFailed(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	if err := jsonStore.Save(verificationState("/path/that/does/not/exist")); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	verification, err := svc.RunVerification(context.Background(), "repo_1", "mission_1", "printf verified")
	if err != nil {
		t.Fatalf("RunVerification() error = %v", err)
	}

	if verification.Status != domain.VerificationStatusFailed {
		t.Fatalf("verification status = %q, want %q", verification.Status, domain.VerificationStatusFailed)
	}

	if verification.ExitCode != nil {
		t.Fatalf("exit code = %v, want nil", verification.ExitCode)
	}

	if verification.Output == "" {
		t.Fatal("expected startup failure output")
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Missions[0].Status != domain.MissionStatusFailed {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, domain.MissionStatusFailed)
	}

	assertVerificationEvents(t, got.WorkflowEvents, domain.WorkflowEventVerificationFailed)
}

func assertVerificationEvents(t *testing.T, events []domain.WorkflowEvent, wantFinalType domain.WorkflowEventType) {
	t.Helper()

	if len(events) != 2 {
		t.Fatalf("expected 2 verification events, got %d", len(events))
	}

	if events[0].Type != domain.WorkflowEventVerificationRun {
		t.Fatalf("first event type = %q, want %q", events[0].Type, domain.WorkflowEventVerificationRun)
	}

	if events[1].Type != wantFinalType {
		t.Fatalf("second event type = %q, want %q", events[1].Type, wantFinalType)
	}

	for _, event := range events {
		if event.MissionID != "mission_1" {
			t.Fatalf("event mission ID = %q, want %q", event.MissionID, "mission_1")
		}
	}
}

func TestRunVerificationRejectsUnknownRepository(t *testing.T) {
	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.RunVerification(context.Background(), "missing_repo", "mission_1", "true"); err == nil {
		t.Fatal("expected error for unknown repository, got nil")
	}
}

func TestRunVerificationRejectsUnknownMission(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{
				ID:   "repo_1",
				Path: t.TempDir(),
				Name: "demo",
			},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.RunVerification(context.Background(), "repo_1", "missing_mission", "true"); err == nil {
		t.Fatal("expected error for unknown mission, got nil")
	}
}

func TestRunVerificationRejectsDraftMission(t *testing.T) {
	assertRunVerificationRejectsMissionStatus(t, domain.MissionStatusDraft)
}

func TestRunVerificationRejectsWaitingApprovalMission(t *testing.T) {
	assertRunVerificationRejectsMissionStatus(t, domain.MissionStatusWaitingApproval)
}

func TestRunVerificationRejectsRejectedMission(t *testing.T) {
	assertRunVerificationRejectsMissionStatus(t, domain.MissionStatusRejected)
}

func assertRunVerificationRejectsMissionStatus(t *testing.T, status domain.MissionStatus) {
	t.Helper()

	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	state := verificationState(t.TempDir())
	state.Missions[0].Status = status

	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.RunVerification(context.Background(), "repo_1", "mission_1", "true"); err == nil {
		t.Fatalf("expected error for mission status %q, got nil", status)
	}

	got, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got.Missions[0].Status != status {
		t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, status)
	}

	if len(got.VerificationRuns) != 0 {
		t.Fatalf("expected 0 verification runs, got %d", len(got.VerificationRuns))
	}

	if len(got.WorkflowEvents) != 0 {
		t.Fatalf("expected 0 workflow events, got %d", len(got.WorkflowEvents))
	}
}

func verificationState(repoPath string) *store.State {
	now := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)

	return &store.State{
		Repositories: []domain.Repository{
			{
				ID:        "repo_1",
				Path:      repoPath,
				Name:      "demo",
				CreatedAt: now,
			},
		},
		Missions: []domain.Mission{
			{
				ID:           "mission_1",
				RepositoryID: "repo_1",
				Text:         "add a version command",
				Status:       domain.MissionStatusApplied,
				CreatedAt:    now,
				UpdatedAt:    now,
			},
		},
	}
}
