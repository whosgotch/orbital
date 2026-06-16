package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

type LocalCommandWorker struct {
	command string
}

func NewLocalCommandWorker(command string) *LocalCommandWorker {
	return &LocalCommandWorker{command: strings.TrimSpace(command)}
}

func (w *LocalCommandWorker) Name() string {
	return "local-command"
}

func (w *LocalCommandWorker) Profile() WorkerProfile {
	return WorkerProfile{
		Name: "local-command",
		Mode: "local-process",
		Roles: []string{
			"AI Manager",
			"Engineer",
			"QA",
		},
		Capabilities: []string{
			"run external commands from the repository root",
			"pass mission context through environment variables",
			"load patch artifacts written to ORBITAL_PATCH_PATH",
			"report command success or failure",
		},
		Limitations: []string{
			"does not stream structured agent events yet",
		},
	}
}

func (w *LocalCommandWorker) CheckAvailable(ctx context.Context) (*WorkerInfo, error) {
	if w.command == "" {
		return &WorkerInfo{
			Name:      w.Name(),
			Available: false,
			Reason:    "local command is not configured",
			Profile:   w.Profile(),
		}, nil
	}

	return &WorkerInfo{
		Name:      w.Name(),
		Available: true,
		Profile:   w.Profile(),
	}, nil
}

func (w *LocalCommandWorker) Supports(ctx context.Context, request RunRequest) SupportResult {
	if w.command == "" {
		return SupportResult{
			Supported: false,
			Reason:    "local command is not configured",
		}
	}

	return SupportResult{Supported: true}
}

func (w *LocalCommandWorker) StartRun(ctx context.Context, request RunRequest) (<-chan RunEvent, error) {
	events := make(chan RunEvent)

	go func() {
		defer close(events)

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunStarted, "Local command worker started.", "", "") {
			return
		}

		if !sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventCommandExecuted, "Local command started.", "", w.command) {
			return
		}

		patchPath := localCommandPatchPath(request)
		output, err := w.runCommand(ctx, request, patchPath)
		if err != nil {
			sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunFailed, fmt.Sprintf("Local command failed: %s", strings.TrimSpace(output)), "", w.command)
			return
		}

		if !w.sendPatchArtifact(ctx, events, request.RunID, patchPath) {
			return
		}

		sendWorkflowEvent(ctx, events, request.RunID, domain.WorkflowEventRunCompleted, "Local command completed.", "", w.command)
	}()

	return events, nil
}

func (w *LocalCommandWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}

func (w *LocalCommandWorker) runCommand(ctx context.Context, request RunRequest, patchPath string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(patchPath), 0755); err != nil {
		return "", err
	}

	shell, shellFlag := commandShell()
	cmd := exec.CommandContext(ctx, shell, shellFlag, w.command)
	cmd.Dir = request.RepoPath
	cmd.Env = append(os.Environ(),
		"ORBITAL_RUN_ID="+request.RunID,
		"ORBITAL_MISSION_ID="+request.MissionID,
		"ORBITAL_REPO_PATH="+request.RepoPath,
		"ORBITAL_MISSION_TEXT="+request.MissionText,
		"ORBITAL_PATCH_PATH="+patchPath,
	)

	output, err := cmd.CombinedOutput()
	return string(output), err
}

func (w *LocalCommandWorker) sendPatchArtifact(ctx context.Context, events chan<- RunEvent, runID string, patchPath string) bool {
	diff, err := os.ReadFile(patchPath)
	if err != nil {
		if os.IsNotExist(err) {
			return true
		}

		sendWorkflowEvent(ctx, events, runID, domain.WorkflowEventRunFailed, fmt.Sprintf("Read patch artifact failed: %v", err), "", w.command)
		return false
	}

	if strings.TrimSpace(string(diff)) == "" {
		return true
	}

	now := time.Now().UTC()
	patch := domain.PatchProposal{
		ID:        fmt.Sprintf("patch_%d", now.UnixNano()),
		RunID:     runID,
		Status:    domain.PatchStatusPending,
		Diff:      string(diff),
		CreatedAt: now,
		UpdatedAt: now,
	}

	select {
	case <-ctx.Done():
		sendCancelledEvent(events, runID)
		return false
	case events <- RunEvent{PatchProposal: &patch}:
	}

	return sendWorkflowEvent(ctx, events, runID, domain.WorkflowEventPatchProposed, "Local command produced a patch artifact.", patchPath, w.command)
}

func localCommandPatchPath(request RunRequest) string {
	return filepath.Join(request.RepoPath, ".orbital", "runs", request.RunID, "patch.diff")
}

func commandShell() (string, string) {
	if runtime.GOOS == "windows" {
		return "cmd", "/C"
	}

	return "sh", "-c"
}

func sendWorkflowEvent(
	ctx context.Context,
	events chan<- RunEvent,
	runID string,
	eventType domain.WorkflowEventType,
	message string,
	filePath string,
	command string,
) bool {
	event := domain.WorkflowEvent{
		ID:        fmt.Sprintf("event_%d", time.Now().UTC().UnixNano()),
		RunID:     runID,
		Type:      eventType,
		Message:   message,
		FilePath:  filePath,
		Command:   command,
		CreatedAt: time.Now().UTC(),
	}

	select {
	case <-ctx.Done():
		sendCancelledEvent(events, runID)
		return false
	case events <- RunEvent{WorkflowEvent: &event}:
		return true
	}
}
