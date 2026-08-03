package app

import (
	"context"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// A chat turn that changes no files proposes no patch. The mission must still
// come to rest, or its node pulses as busy forever and never reads as
// chattable again — the state a landed mission's follow-up turns always hit.
func TestChatTurnWithoutPatchSettlesMission(t *testing.T) {
	for _, tc := range []struct {
		name        string
		patchStatus domain.PatchStatus
		want        domain.MissionStatus
	}{
		{name: "nothing landed yet", want: domain.MissionStatusDraft},
		{name: "work already applied", patchStatus: domain.PatchStatusApplied, want: domain.MissionStatusApplied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			jsonStore := store.NewJSONStore(t.TempDir())
			registry := agent.NewWorkerRegistry()
			registry.Register(&recordingChatWorker{sessionID: "sess_test"})
			svc := NewServiceWithWorkerRegistry(jsonStore, registry)

			state := &store.State{
				Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
				Missions:     []domain.Mission{{ID: "mission_1", RepositoryID: "repo_1", Text: "start", Status: domain.MissionStatusDraft}},
			}
			if tc.patchStatus != "" {
				state.AgentRuns = []domain.AgentRun{{ID: "run_prior", MissionID: "mission_1", WorkerName: "claude-engineer"}}
				state.PatchProposals = []domain.PatchProposal{{ID: "patch_prior", RunID: "run_prior", Status: tc.patchStatus}}
			}
			if err := jsonStore.Save(state); err != nil {
				t.Fatalf("Save() error = %v", err)
			}

			if _, err := svc.SendAgentMessage(context.Background(), "mission_1", "what does this file do?"); err != nil {
				t.Fatalf("SendAgentMessage() error = %v", err)
			}

			got, err := jsonStore.Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if got.Missions[0].Status != tc.want {
				t.Fatalf("mission status = %q, want %q", got.Missions[0].Status, tc.want)
			}
		})
	}
}
