package app

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func (s *Service) RunVerification(ctx context.Context, repoID string, missionID string, command string) (*domain.VerificationRun, error) {
	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	repositoryIndex := findRepositoryIndex(state.Repositories, repoID)
	if repositoryIndex == -1 {
		return nil, fmt.Errorf("repository not found: %s", repoID)
	}

	missionIndex := findMissionIndex(state.Missions, missionID)
	if missionIndex == -1 {
		return nil, fmt.Errorf("mission not found: %s", missionID)
	}

	if state.Missions[missionIndex].RepositoryID != repoID {
		return nil, fmt.Errorf("mission %s does not belong to repository %s", missionID, repoID)
	}

	startedAt := time.Now().UTC()
	verification := domain.VerificationRun{
		ID:           fmt.Sprintf("verification_%d", startedAt.UnixNano()),
		MissionID:    missionID,
		RepositoryID: repoID,
		Command:      command,
		Status:       domain.VerificationStatusRunning,
		StartedAt:    startedAt,
	}
	state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
		missionID,
		"",
		domain.WorkflowEventVerificationRun,
		"Verification started.",
		command,
		startedAt,
	))

	shell, shellFlag := verificationShell()
	cmd := exec.CommandContext(ctx, shell, shellFlag, command)
	cmd.Dir = state.Repositories[repositoryIndex].Path

	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output

	err = cmd.Run()

	completedAt := time.Now().UTC()
	exitCode := cmd.ProcessState.ExitCode()
	verification.ExitCode = &exitCode
	verification.Output = output.String()
	verification.CompletedAt = &completedAt

	if err == nil {
		verification.Status = domain.VerificationStatusPassed
		state.Missions[missionIndex].Status = domain.MissionStatusVerified
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			missionID,
			"",
			domain.WorkflowEventVerificationPassed,
			"Verification passed.",
			command,
			completedAt,
		))
	} else {
		verification.Status = domain.VerificationStatusFailed
		state.Missions[missionIndex].Status = domain.MissionStatusFailed
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			missionID,
			"",
			domain.WorkflowEventVerificationFailed,
			"Verification failed.",
			command,
			completedAt,
		))
	}
	state.Missions[missionIndex].UpdatedAt = completedAt

	state.VerificationRuns = append(state.VerificationRuns, verification)

	if saveErr := s.store.Save(state); saveErr != nil {
		return nil, saveErr
	}

	return &verification, nil
}

func verificationShell() (string, string) {
	if runtime.GOOS == "windows" {
		return "cmd", "/C"
	}

	return "sh", "-c"
}
