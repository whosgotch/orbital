package domain

import "time"

type WorkflowEventType string

const (
	WorkflowEventRunStarted      WorkflowEventType = "run_started"
	WorkflowEventRepoInspected   WorkflowEventType = "repo_inspected"
	WorkflowEventFileRead        WorkflowEventType = "file_read"
	WorkflowEventCommandExecuted WorkflowEventType = "command_executed"
	WorkflowEventPatchProposed   WorkflowEventType = "patch_proposed"
	WorkflowEventRunCompleted    WorkflowEventType = "run_completed"
	WorkflowEventRunFailed       WorkflowEventType = "run_failed"
	WorkflowEventRunCancelled    WorkflowEventType = "run_cancelled"
)

type WorkflowEvent struct {
	ID        string            `json:"id"`
	RunID     string            `json:"run_id"`
	Type      WorkflowEventType `json:"type"`
	Message   string            `json:"message"`
	FilePath  string            `json:"file_path,omitempty"`
	Command   string            `json:"command,omitempty"`
	CreatedAt time.Time         `json:"created_at"`
}
