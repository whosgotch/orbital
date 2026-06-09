package agent

import (
	"context"
	"fmt"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

type MockWorker struct{}

func NewMockWorker() *MockWorker {
	return &MockWorker{}
}

func (w *MockWorker) Name() string {
	return "mock"
}

func (w *MockWorker) CheckAvailable(ctx context.Context) (*WorkerInfo, error) {
	return &WorkerInfo{
		Name:      w.Name(),
		Available: true,
	}, nil
}

func (w *MockWorker) StartRun(ctx context.Context, request RunRequest) (<-chan RunEvent, error) {
	events := make(chan RunEvent)

	go func() {
		defer close(events)

		sendEvent := func(eventType domain.WorkflowEventType, message string, filePath string) bool {
			event := domain.WorkflowEvent{
				ID:        fmt.Sprintf("event_%d", time.Now().UTC().UnixNano()),
				RunID:     request.RunID,
				Type:      eventType,
				Message:   message,
				FilePath:  filePath,
				CreatedAt: time.Now().UTC(),
			}

			select {
			case <-ctx.Done():
				sendCancelledEvent(events, request.RunID)
				return false
			case events <- RunEvent{WorkflowEvent: &event}:
				return true
			}
		}

		if !sendEvent(domain.WorkflowEventRunStarted, "Mock worker started.", "") {
			return
		}

		if !sendEvent(domain.WorkflowEventRepoInspected, "Repository inspected.", "") {
			return
		}

		if !sendEvent(domain.WorkflowEventFileRead, "Read package metadata.", "package.json") {
			return
		}

		if !sendEvent(domain.WorkflowEventFileRead, "Read CLI entrypoint.", "src/cli.ts") {
			return
		}

		now := time.Now().UTC()
		patch := domain.PatchProposal{
			ID:        fmt.Sprintf("patch_%d", now.UnixNano()),
			RunID:     request.RunID,
			Status:    domain.PatchStatusPending,
			Diff:      mockVersionCommandDiff,
			CreatedAt: now,
			UpdatedAt: now,
		}

		select {
		case <-ctx.Done():
			sendCancelledEvent(events, request.RunID)
			return
		case events <- RunEvent{PatchProposal: &patch}:
		}

		if !sendEvent(domain.WorkflowEventPatchProposed, "Patch proposed.", "") {
			return
		}

		sendEvent(domain.WorkflowEventRunCompleted, "Mock worker completed.", "")
	}()

	return events, nil
}

func (w *MockWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}

func sendCancelledEvent(events chan<- RunEvent, runID string) {
	events <- RunEvent{
		WorkflowEvent: &domain.WorkflowEvent{
			ID:        fmt.Sprintf("event_%d", time.Now().UTC().UnixNano()),
			RunID:     runID,
			Type:      domain.WorkflowEventRunCancelled,
			Message:   "Run cancelled.",
			CreatedAt: time.Now().UTC(),
		},
	}
}

const mockVersionCommandDiff = `diff --git a/package.json b/package.json
index 2b13a1c..91d44fd 100644
--- a/package.json
+++ b/package.json
@@ -4,6 +4,7 @@
   "bin": {
     "demo": "./dist/cli.js"
   },
+  "version": "0.1.0",
   "scripts": {
     "build": "tsc",
     "test": "vitest run"
diff --git a/src/cli.ts b/src/cli.ts
index 8b891fa..7f1c0db 100644
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -1,5 +1,10 @@
 import pkg from "../package.json";

 const command = process.argv[2];

+if (command === "version" || command === "--version") {
+  console.log(pkg.version);
+  process.exit(0);
+}
+
 console.log("Usage: demo <command>");
`
