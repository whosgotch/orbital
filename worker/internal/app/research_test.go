package app

import (
	"context"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestCreateResearchMissionRecordsKind(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	mission, err := svc.CreateResearchMission("repo_1", "how does the plan engine work?", "", "")
	if err != nil {
		t.Fatalf("CreateResearchMission() error = %v", err)
	}

	if mission.Kind != domain.MissionKindResearch {
		t.Fatalf("mission kind = %q, want %q", mission.Kind, domain.MissionKindResearch)
	}
	if !mission.IsResearch() {
		t.Fatal("IsResearch() = false, want true")
	}
}

// A research mission always dispatches on the researcher — whatever worker the
// caller asked for — and lands as verified: its findings need no approve gate.
func TestStartAgentRunResearchUsesResearcherAndLandsVerified(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	researcher := &recordingChatWorker{name: "claude-researcher", sessionID: "sess_research"}
	registry := agent.NewWorkerRegistry()
	registry.Register(researcher)
	svc := NewServiceWithWorkerRegistry(jsonStore, registry)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions: []domain.Mission{{
			ID:           "mission_1",
			RepositoryID: "repo_1",
			Text:         "map the worker architecture",
			Status:       domain.MissionStatusDraft,
			Kind:         domain.MissionKindResearch,
		}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	run, err := svc.StartAgentRun(context.Background(), "mission_1", "mock")
	if err != nil {
		t.Fatalf("StartAgentRun() error = %v", err)
	}

	if run.WorkerName != "claude-researcher" {
		t.Fatalf("run worker = %q, want claude-researcher", run.WorkerName)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got := state.Missions[0].Status; got != domain.MissionStatusVerified {
		t.Fatalf("mission status = %q, want %q", got, domain.MissionStatusVerified)
	}
	if len(state.PatchProposals) != 0 {
		t.Fatalf("research produced %d patches, want 0", len(state.PatchProposals))
	}
	// The chat keeps the short note; the findings land on the mission itself.
	if len(state.ChatMessages) == 0 {
		t.Fatal("expected the researcher's note in chat messages")
	}
	if state.Missions[0].Document == "" {
		t.Fatal("expected the findings document stored on the mission")
	}
}

func TestSendAgentMessageResearchTalksToResearcher(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	engineer := &recordingChatWorker{sessionID: "sess_eng"}
	researcher := &recordingChatWorker{name: "claude-researcher", sessionID: "sess_research"}
	registry := agent.NewWorkerRegistry()
	registry.Register(engineer)
	registry.Register(researcher)
	svc := NewServiceWithWorkerRegistry(jsonStore, registry)

	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions: []domain.Mission{{
			ID:           "mission_1",
			RepositoryID: "repo_1",
			Text:         "what is missing in the docs?",
			Status:       domain.MissionStatusDraft,
			Kind:         domain.MissionKindResearch,
		}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.SendAgentMessage(context.Background(), "mission_1", "and compare with the README"); err != nil {
		t.Fatalf("SendAgentMessage() error = %v", err)
	}

	if len(researcher.requests()) != 1 {
		t.Fatalf("researcher turns = %d, want 1", len(researcher.requests()))
	}
	if len(engineer.requests()) != 0 {
		t.Fatalf("engineer turns = %d, want 0 — research chat must not reach the engineer", len(engineer.requests()))
	}
}
