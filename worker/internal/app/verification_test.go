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
				Status:       domain.MissionStatusApproved,
				CreatedAt:    now,
				UpdatedAt:    now,
			},
		},
	}
}
