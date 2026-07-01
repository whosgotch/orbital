package app

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestSendAgentMessageStartsThenResumesOneAgent(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	worker := &recordingChatWorker{sessionID: "sess_test"}
	registry := agent.NewWorkerRegistry()
	registry.Register(worker)
	svc := NewServiceWithWorkerRegistry(jsonStore, registry)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions:     []domain.Mission{{ID: "mission_1", RepositoryID: "repo_1", Text: "start", Status: domain.MissionStatusDraft}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	ctx := context.Background()
	if _, err := svc.SendAgentMessage(ctx, "mission_1", "add a health route"); err != nil {
		t.Fatalf("SendAgentMessage(first) error = %v", err)
	}
	if _, err := svc.SendAgentMessage(ctx, "mission_1", "also return the build sha"); err != nil {
		t.Fatalf("SendAgentMessage(second) error = %v", err)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	// Both turns steer the SAME agent — one run, one session.
	runs := 0
	var run domain.AgentRun
	for _, r := range state.AgentRuns {
		if r.MissionID == "mission_1" {
			runs++
			run = r
		}
	}
	if runs != 1 {
		t.Fatalf("agent runs for mission = %d, want 1 (turns must reuse one agent)", runs)
	}
	if run.SessionID != "sess_test" {
		t.Fatalf("run session id = %q, want sess_test", run.SessionID)
	}

	// The conversation records both turns: user + assistant for each.
	var users, assistants int
	for _, m := range state.ChatMessages {
		switch m.Role {
		case domain.ChatRoleUser:
			users++
		case domain.ChatRoleAssistant:
			assistants++
		}
	}
	if users != 2 || assistants != 2 {
		t.Fatalf("chat messages = %d user / %d assistant, want 2/2", users, assistants)
	}

	// The second turn must resume the session captured on the first.
	reqs := worker.requests()
	if len(reqs) != 2 {
		t.Fatalf("worker saw %d turns, want 2", len(reqs))
	}
	if reqs[0].ResumeSessionID != "" {
		t.Errorf("first turn should not resume, got %q", reqs[0].ResumeSessionID)
	}
	if reqs[1].ResumeSessionID != "sess_test" {
		t.Errorf("second turn resume id = %q, want sess_test", reqs[1].ResumeSessionID)
	}
}

// recordingChatWorker stands in for claude-engineer: it records each turn's
// request and emits a captured session id plus an assistant reply, so the chat
// orchestration can be tested without the claude CLI.
type recordingChatWorker struct {
	sessionID string
	mu        sync.Mutex
	seen      []agent.RunRequest
}

func (w *recordingChatWorker) Name() string { return "claude-engineer" }

func (w *recordingChatWorker) Profile() agent.WorkerProfile {
	return agent.WorkerProfile{Name: w.Name(), Mode: "test"}
}

func (w *recordingChatWorker) CheckAvailable(ctx context.Context) (*agent.WorkerInfo, error) {
	return &agent.WorkerInfo{Name: w.Name(), Available: true, Profile: w.Profile()}, nil
}

func (w *recordingChatWorker) Supports(ctx context.Context, request agent.RunRequest) agent.SupportResult {
	return agent.SupportResult{Supported: true}
}

func (w *recordingChatWorker) StartRun(ctx context.Context, request agent.RunRequest) (<-chan agent.RunEvent, error) {
	w.mu.Lock()
	w.seen = append(w.seen, request)
	w.mu.Unlock()

	events := make(chan agent.RunEvent, 2)
	now := time.Now().UTC()
	events <- agent.RunEvent{SessionID: w.sessionID}
	events <- agent.RunEvent{ChatMessage: &domain.ChatMessage{
		ID:        fmt.Sprintf("msg_%s", request.RunID),
		MissionID: request.MissionID,
		RunID:     request.RunID,
		Role:      domain.ChatRoleAssistant,
		Text:      "done: " + request.MissionText,
		CreatedAt: now,
	}}
	close(events)
	return events, nil
}

func (w *recordingChatWorker) CancelRun(ctx context.Context, runID string) error { return nil }

func (w *recordingChatWorker) requests() []agent.RunRequest {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]agent.RunRequest(nil), w.seen...)
}
