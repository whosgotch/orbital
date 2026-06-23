package app

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func (s *Service) RunVerification(ctx context.Context, repoID string, missionID string, command string) (*domain.VerificationRun, error) {
	startedAt := time.Now().UTC()
	verification := domain.VerificationRun{
		ID:           fmt.Sprintf("verification_%d", startedAt.UnixNano()),
		MissionID:    missionID,
		RepositoryID: repoID,
		Command:      command,
		Status:       domain.VerificationStatusRunning,
		StartedAt:    startedAt,
	}

	// First transaction: validate, record the running verification, and capture
	// the repo path. The lock is released before the command runs so it never
	// blocks other missions' writes for the duration of the verification.
	var repoPath string
	if _, err := s.store.Update(func(state *store.State) error {
		repositoryIndex := findRepositoryIndex(state.Repositories, repoID)
		if repositoryIndex == -1 {
			return fmt.Errorf("repository not found: %s", repoID)
		}

		missionIndex := findMissionIndex(state.Missions, missionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}

		if state.Missions[missionIndex].RepositoryID != repoID {
			return fmt.Errorf("mission %s does not belong to repository %s", missionID, repoID)
		}

		if state.Missions[missionIndex].Status != domain.MissionStatusApplied {
			return fmt.Errorf("mission must be applied before verification: %s", missionID)
		}

		repoPath = state.Repositories[repositoryIndex].Path
		state.VerificationRuns = append(state.VerificationRuns, verification)
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			missionID, "", domain.WorkflowEventVerificationRun, "Verification started.", command, startedAt,
		))
		return nil
	}); err != nil {
		return nil, err
	}

	shell, shellFlag := verificationShell()
	cmd := exec.CommandContext(ctx, shell, shellFlag, command)
	cmd.Dir = repoPath

	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output

	runErr := cmd.Run()

	completedAt := time.Now().UTC()
	if cmd.ProcessState != nil {
		exitCode := cmd.ProcessState.ExitCode()
		verification.ExitCode = &exitCode
	}
	verification.Output = output.String()
	if verification.Output == "" && runErr != nil {
		verification.Output = runErr.Error()
	}
	verification.CompletedAt = &completedAt
	if runErr == nil {
		verification.Status = domain.VerificationStatusPassed
	} else {
		verification.Status = domain.VerificationStatusFailed
	}

	// Second transaction: record the outcome on the verification run, advance
	// the mission, and emit the pass/fail event.
	if _, err := s.store.Update(func(state *store.State) error {
		for index := range state.VerificationRuns {
			if state.VerificationRuns[index].ID == verification.ID {
				state.VerificationRuns[index] = verification
				break
			}
		}

		missionIndex := findMissionIndex(state.Missions, missionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", missionID)
		}

		if runErr == nil {
			state.Missions[missionIndex].Status = domain.MissionStatusVerified
			state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
				missionID, "", domain.WorkflowEventVerificationPassed, "Verification passed.", command, completedAt,
			))
		} else {
			state.Missions[missionIndex].Status = domain.MissionStatusFailed
			state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
				missionID, "", domain.WorkflowEventVerificationFailed, "Verification failed.", command, completedAt,
			))
		}
		state.Missions[missionIndex].UpdatedAt = completedAt
		return nil
	}); err != nil {
		return nil, err
	}

	return &verification, nil
}

func verificationShell() (string, string) {
	if runtime.GOOS == "windows" {
		return "cmd", "/C"
	}

	return "sh", "-c"
}
