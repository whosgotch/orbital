package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func TestLocalCommandWorkerCheckAvailableRequiresCommand(t *testing.T) {
	worker := NewLocalCommandWorker("")

	info, err := worker.CheckAvailable(context.Background())
	if err != nil {
		t.Fatalf("CheckAvailable() error = %v", err)
	}

	if info.Available {
		t.Fatal("expected worker to be unavailable without a command")
	}

	if info.Profile.Mode != "local-process" {
		t.Fatalf("worker mode = %q, want %q", info.Profile.Mode, "local-process")
	}
}

func TestLocalCommandWorkerEmitsCommandEvents(t *testing.T) {
	worker := NewLocalCommandWorker(`test "$ORBITAL_MISSION_TEXT" = "ship it" && printf "worker summary"`)
	events, err := worker.StartRun(context.Background(), RunRequest{
		RunID:       "run_1",
		MissionID:   "mission_1",
		RepoPath:    t.TempDir(),
		MissionText: "ship it",
	})
	if err != nil {
		t.Fatalf("StartRun() error = %v", err)
	}

	got := collectWorkflowEventTypes(events)
	want := []domain.WorkflowEventType{
		domain.WorkflowEventRunStarted,
		domain.WorkflowEventCommandExecuted,
		domain.WorkflowEventCommandExecuted,
		domain.WorkflowEventRunCompleted,
	}

	if strings.Join(eventTypeStrings(got), ",") != strings.Join(eventTypeStrings(want), ",") {
		t.Fatalf("event types = %v, want %v", got, want)
	}
}

func TestLocalCommandWorkerCapturesCommandOutput(t *testing.T) {
	worker := NewLocalCommandWorker("printf 'agent summary'")
	events, err := worker.StartRun(context.Background(), RunRequest{
		RunID:       "run_1",
		MissionID:   "mission_1",
		RepoPath:    t.TempDir(),
		MissionText: "ship it",
	})
	if err != nil {
		t.Fatalf("StartRun() error = %v", err)
	}

	var messages []string
	for event := range events {
		if event.WorkflowEvent != nil {
			messages = append(messages, event.WorkflowEvent.Message)
		}
	}

	if !containsMessage(messages, "Local command output: agent summary") {
		t.Fatalf("messages = %v, want captured output", messages)
	}
}

func TestLocalCommandWorkerTruncatesCommandOutput(t *testing.T) {
	message := localCommandOutputMessage(strings.Repeat("x", maxLocalCommandOutputMessage+20))

	if len(message) != len("Local command output: ")+maxLocalCommandOutputMessage+3 {
		t.Fatalf("message length = %d, want bounded output length", len(message))
	}
	if !strings.HasSuffix(message, "...") {
		t.Fatalf("message = %q, want ellipsis suffix", message)
	}
}

func TestLocalCommandWorkerEmitsFailedEvent(t *testing.T) {
	worker := NewLocalCommandWorker("printf nope && exit 9")
	events, err := worker.StartRun(context.Background(), RunRequest{
		RunID:       "run_1",
		MissionID:   "mission_1",
		RepoPath:    t.TempDir(),
		MissionText: "ship it",
	})
	if err != nil {
		t.Fatalf("StartRun() error = %v", err)
	}

	got := collectWorkflowEventTypes(events)
	if got[len(got)-1] != domain.WorkflowEventRunFailed {
		t.Fatalf("last event type = %q, want %q", got[len(got)-1], domain.WorkflowEventRunFailed)
	}
}

func TestLocalCommandWorkerEmitsPatchArtifact(t *testing.T) {
	worker := NewLocalCommandWorker("printf 'diff --git a/a.txt b/a.txt\n' > \"$ORBITAL_PATCH_PATH\"")
	events, err := worker.StartRun(context.Background(), RunRequest{
		RunID:       "run_1",
		MissionID:   "mission_1",
		RepoPath:    t.TempDir(),
		MissionText: "ship it",
	})
	if err != nil {
		t.Fatalf("StartRun() error = %v", err)
	}

	var patchCount int
	var eventTypes []domain.WorkflowEventType
	for event := range events {
		if event.WorkflowEvent != nil {
			eventTypes = append(eventTypes, event.WorkflowEvent.Type)
		}
		if event.PatchProposal != nil {
			patchCount++
			if !strings.Contains(event.PatchProposal.Diff, "diff --git") {
				t.Fatalf("patch diff = %q, want diff content", event.PatchProposal.Diff)
			}
		}
	}

	if patchCount != 1 {
		t.Fatalf("expected 1 patch proposal, got %d", patchCount)
	}

	if eventTypes[len(eventTypes)-2] != domain.WorkflowEventPatchProposed {
		t.Fatalf("penultimate event type = %q, want %q", eventTypes[len(eventTypes)-2], domain.WorkflowEventPatchProposed)
	}
	if eventTypes[len(eventTypes)-1] != domain.WorkflowEventRunCompleted {
		t.Fatalf("last event type = %q, want %q", eventTypes[len(eventTypes)-1], domain.WorkflowEventRunCompleted)
	}
}

func containsMessage(messages []string, want string) bool {
	for _, message := range messages {
		if message == want {
			return true
		}
	}

	return false
}

func collectWorkflowEventTypes(events <-chan RunEvent) []domain.WorkflowEventType {
	var eventTypes []domain.WorkflowEventType
	for event := range events {
		if event.WorkflowEvent != nil {
			eventTypes = append(eventTypes, event.WorkflowEvent.Type)
		}
	}

	return eventTypes
}

func eventTypeStrings(eventTypes []domain.WorkflowEventType) []string {
	values := make([]string, 0, len(eventTypes))
	for _, eventType := range eventTypes {
		values = append(values, string(eventType))
	}

	return values
}
