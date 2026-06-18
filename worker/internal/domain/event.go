package domain

import "time"

type WorkflowEventType string

const (
	WorkflowEventRunStarted         WorkflowEventType = "run_started"
	WorkflowEventRepoInspected      WorkflowEventType = "repo_inspected"
	WorkflowEventFileRead           WorkflowEventType = "file_read"
	WorkflowEventCommandExecuted    WorkflowEventType = "command_executed"
	WorkflowEventPatchProposed      WorkflowEventType = "patch_proposed"
	WorkflowEventPatchApproved      WorkflowEventType = "patch_approved"
	WorkflowEventPatchRejected      WorkflowEventType = "patch_rejected"
	WorkflowEventPatchApplied       WorkflowEventType = "patch_applied"
	WorkflowEventVerificationRun    WorkflowEventType = "verification_run"
	WorkflowEventVerificationPassed WorkflowEventType = "verification_passed"
	WorkflowEventVerificationFailed WorkflowEventType = "verification_failed"
	WorkflowEventRunCompleted       WorkflowEventType = "run_completed"
	WorkflowEventRunFailed          WorkflowEventType = "run_failed"
	WorkflowEventRunCancelled       WorkflowEventType = "run_cancelled"
	WorkflowEventChildRunSpawned    WorkflowEventType = "child_run_spawned"
	WorkflowEventChildRunCompleted  WorkflowEventType = "child_run_completed"
	WorkflowEventChildRunFailed     WorkflowEventType = "child_run_failed"
	WorkflowEventPatchesMerged      WorkflowEventType = "patches_merged"
)

type WorkflowEvent struct {
	ID        string            `json:"id"`
	MissionID string            `json:"mission_id,omitempty"`
	RunID     string            `json:"run_id,omitempty"`
	Type      WorkflowEventType `json:"type"`
	Message   string            `json:"message"`
	FilePath  string            `json:"file_path,omitempty"`
	Command   string            `json:"command,omitempty"`
	CreatedAt time.Time         `json:"created_at"`
}
