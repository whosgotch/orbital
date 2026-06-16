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
	worker := NewLocalCommandWorker(`test "$ORBITAL_MISSION_TEXT" = "ship it"`)
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
		domain.WorkflowEventRunCompleted,
	}

	if strings.Join(eventTypeStrings(got), ",") != strings.Join(eventTypeStrings(want), ",") {
		t.Fatalf("event types = %v, want %v", got, want)
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
