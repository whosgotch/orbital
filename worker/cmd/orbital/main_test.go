package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestCreateDemoFixtureResetsFilesAndState(t *testing.T) {
	repoDir := t.TempDir()
	stateDir := filepath.Join(repoDir, ".orbital")
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		t.Fatalf("MkdirAll(.orbital) error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(stateDir, "state.json"), []byte("{}"), 0644); err != nil {
		t.Fatalf("WriteFile(state.json) error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "package.json"), []byte(`{"version":"0.1.0"}`), 0644); err != nil {
		t.Fatalf("WriteFile(package.json) error = %v", err)
	}

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "demo-fixture", repoDir}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	packageJSON, err := os.ReadFile(filepath.Join(repoDir, "package.json"))
	if err != nil {
		t.Fatalf("ReadFile(package.json) error = %v", err)
	}

	if string(packageJSON) != demoPackageJSON {
		t.Fatalf("package.json = %q, want fixture content", string(packageJSON))
	}

	cli, err := os.ReadFile(filepath.Join(repoDir, "src", "cli.ts"))
	if err != nil {
		t.Fatalf("ReadFile(cli.ts) error = %v", err)
	}

	if string(cli) != demoCLI {
		t.Fatalf("cli.ts = %q, want fixture content", string(cli))
	}

	if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
		t.Fatalf("expected .orbital to be removed, stat error = %v", err)
	}

	if output.String() == "" {
		t.Fatal("expected fixture command output")
	}
}

func TestRunRejectsUnknownCommand(t *testing.T) {
	if err := run(context.Background(), []string{"orbital", "unknown"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected usage error, got nil")
	}
}

func TestOpenRepositoryPrintsStateJSON(t *testing.T) {
	repoDir := t.TempDir()

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "open", repoDir}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(open JSON) error = %v; output = %q", err, output.String())
	}

	if len(state.Repositories) != 1 {
		t.Fatalf("expected 1 repository, got %d", len(state.Repositories))
	}
	if state.Repositories[0].Path != repoDir {
		t.Fatalf("repository path = %q, want %q", state.Repositories[0].Path, repoDir)
	}
}

func TestQueueMissionCreatesDraftMissionAndPrintsStateJSON(t *testing.T) {
	repoDir := t.TempDir()

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "queue", repoDir, "stabilize release path"}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(queue JSON) error = %v; output = %q", err, output.String())
	}

	if len(state.Repositories) != 1 {
		t.Fatalf("expected 1 repository, got %d", len(state.Repositories))
	}
	if state.Repositories[0].Path != repoDir {
		t.Fatalf("repository path = %q, want %q", state.Repositories[0].Path, repoDir)
	}

	if len(state.Missions) != 1 {
		t.Fatalf("expected 1 mission, got %d", len(state.Missions))
	}
	if state.Missions[0].RepositoryID != state.Repositories[0].ID {
		t.Fatalf("mission repository ID = %q, want %q", state.Missions[0].RepositoryID, state.Repositories[0].ID)
	}
	if state.Missions[0].Text != "stabilize release path" {
		t.Fatalf("mission text = %q, want %q", state.Missions[0].Text, "stabilize release path")
	}
	if state.Missions[0].Status != domain.MissionStatusDraft {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusDraft)
	}
}

func TestQueueToolMissionCreatesToolDraft(t *testing.T) {
	repoDir := t.TempDir()

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "queue", repoDir, "run tests", "--tool", "go test ./..."}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(queue JSON) error = %v; output = %q", err, output.String())
	}

	if len(state.Missions) != 1 {
		t.Fatalf("expected 1 mission, got %d", len(state.Missions))
	}
	if state.Missions[0].Kind != domain.MissionKindTool {
		t.Fatalf("mission kind = %q, want %q", state.Missions[0].Kind, domain.MissionKindTool)
	}
	if state.Missions[0].ToolCommand != "go test ./..." {
		t.Fatalf("tool command = %q, want %q", state.Missions[0].ToolCommand, "go test ./...")
	}
	if state.Missions[0].Status != domain.MissionStatusDraft {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusDraft)
	}
}

func TestStartRunCreatesWorkerRunAndPatch(t *testing.T) {
	repoDir := t.TempDir()
	if err := run(context.Background(), []string{"orbital", "demo-fixture", repoDir}, &bytes.Buffer{}); err != nil {
		t.Fatalf("demo-fixture run() error = %v", err)
	}

	var queueOutput bytes.Buffer
	if err := run(context.Background(), []string{"orbital", "queue", repoDir, "add a version command"}, &queueOutput); err != nil {
		t.Fatalf("queue run() error = %v", err)
	}

	var queuedState store.State
	if err := json.Unmarshal(queueOutput.Bytes(), &queuedState); err != nil {
		t.Fatalf("Unmarshal(queue JSON) error = %v", err)
	}

	var startOutput bytes.Buffer
	err := run(context.Background(), []string{"orbital", "start-run", repoDir, queuedState.Missions[0].ID}, &startOutput)
	if err != nil {
		t.Fatalf("start-run run() error = %v", err)
	}

	state := unmarshalStreamedState(t, startOutput.String())

	if len(state.AgentRuns) != 1 {
		t.Fatalf("expected 1 agent run, got %d", len(state.AgentRuns))
	}
	if state.AgentRuns[0].Status != domain.AgentRunStatusCompleted {
		t.Fatalf("agent run status = %q, want %q", state.AgentRuns[0].Status, domain.AgentRunStatusCompleted)
	}
	if len(state.PatchProposals) != 1 {
		t.Fatalf("expected 1 patch proposal, got %d", len(state.PatchProposals))
	}
	if state.Missions[0].Status != domain.MissionStatusWaitingApproval {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusWaitingApproval)
	}
}

func TestStartRunCanUseLocalCommandWorker(t *testing.T) {
	repoDir := t.TempDir()

	var queueOutput bytes.Buffer
	if err := run(context.Background(), []string{"orbital", "queue", repoDir, "ship it"}, &queueOutput); err != nil {
		t.Fatalf("queue run() error = %v", err)
	}

	var queuedState store.State
	if err := json.Unmarshal(queueOutput.Bytes(), &queuedState); err != nil {
		t.Fatalf("Unmarshal(queue JSON) error = %v", err)
	}

	markerPath := filepath.Join(repoDir, "mission.txt")
	command := "printf \"$ORBITAL_MISSION_TEXT\" > mission.txt"

	var startOutput bytes.Buffer
	err := run(context.Background(), []string{
		"orbital",
		"start-run",
		repoDir,
		queuedState.Missions[0].ID,
		"--worker",
		"local-command",
		"--command",
		command,
	}, &startOutput)
	if err != nil {
		t.Fatalf("start-run run() error = %v", err)
	}

	state := unmarshalStreamedState(t, startOutput.String())

	if state.AgentRuns[0].WorkerName != "local-command" {
		t.Fatalf("worker name = %q, want %q", state.AgentRuns[0].WorkerName, "local-command")
	}
	if state.AgentRuns[0].Status != domain.AgentRunStatusCompleted {
		t.Fatalf("agent run status = %q, want %q", state.AgentRuns[0].Status, domain.AgentRunStatusCompleted)
	}

	marker, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatalf("ReadFile(mission.txt) error = %v", err)
	}
	if string(marker) != "ship it" {
		t.Fatalf("marker = %q, want %q", string(marker), "ship it")
	}
}

func TestStartRunCanUseLocalCommandWorkerPatchArtifact(t *testing.T) {
	repoDir := t.TempDir()

	var queueOutput bytes.Buffer
	if err := run(context.Background(), []string{"orbital", "queue", repoDir, "write a patch"}, &queueOutput); err != nil {
		t.Fatalf("queue run() error = %v", err)
	}

	var queuedState store.State
	if err := json.Unmarshal(queueOutput.Bytes(), &queuedState); err != nil {
		t.Fatalf("Unmarshal(queue JSON) error = %v", err)
	}

	command := "printf 'diff --git a/a.txt b/a.txt\n' > \"$ORBITAL_PATCH_PATH\""

	var startOutput bytes.Buffer
	err := run(context.Background(), []string{
		"orbital",
		"start-run",
		repoDir,
		queuedState.Missions[0].ID,
		"--worker",
		"local-command",
		"--command",
		command,
	}, &startOutput)
	if err != nil {
		t.Fatalf("start-run run() error = %v", err)
	}

	state := unmarshalStreamedState(t, startOutput.String())

	if len(state.PatchProposals) != 1 {
		t.Fatalf("expected 1 patch proposal, got %d", len(state.PatchProposals))
	}
	if !strings.Contains(state.PatchProposals[0].Diff, "diff --git") {
		t.Fatalf("patch diff = %q, want diff content", state.PatchProposals[0].Diff)
	}
	if state.Missions[0].Status != domain.MissionStatusWaitingApproval {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusWaitingApproval)
	}
}

func TestApproveMissionPatchApprovesAndAppliesPatch(t *testing.T) {
	repoDir, missionID := prepareStartedDemoMission(t)

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "approve", repoDir, missionID}, &output)
	if err != nil {
		t.Fatalf("approve run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(approve JSON) error = %v; output = %q", err, output.String())
	}

	if state.Missions[0].Status != domain.MissionStatusApplied {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusApplied)
	}
	if state.PatchProposals[0].Status != domain.PatchStatusApplied {
		t.Fatalf("patch status = %q, want %q", state.PatchProposals[0].Status, domain.PatchStatusApplied)
	}

	packageJSON, err := os.ReadFile(filepath.Join(repoDir, "package.json"))
	if err != nil {
		t.Fatalf("ReadFile(package.json) error = %v", err)
	}
	if !bytes.Contains(packageJSON, []byte(`"version": "0.1.0"`)) {
		t.Fatalf("package.json does not contain applied version: %s", packageJSON)
	}

	cli, err := os.ReadFile(filepath.Join(repoDir, "src", "cli.ts"))
	if err != nil {
		t.Fatalf("ReadFile(cli.ts) error = %v", err)
	}
	if !bytes.Contains(cli, []byte(`command === "version"`)) {
		t.Fatalf("cli.ts does not contain applied version command: %s", cli)
	}
}

func TestApproveMissionPatchTreatsAlreadyAppliedDiffAsApplied(t *testing.T) {
	repoDir, firstMissionID := prepareStartedDemoMission(t)
	if err := run(context.Background(), []string{"orbital", "approve", repoDir, firstMissionID}, &bytes.Buffer{}); err != nil {
		t.Fatalf("first approve run() error = %v", err)
	}

	var queueOutput bytes.Buffer
	if err := run(context.Background(), []string{"orbital", "queue", repoDir, "add a version command again"}, &queueOutput); err != nil {
		t.Fatalf("queue run() error = %v", err)
	}

	var queuedState store.State
	if err := json.Unmarshal(queueOutput.Bytes(), &queuedState); err != nil {
		t.Fatalf("Unmarshal(queue JSON) error = %v", err)
	}
	secondMissionID := queuedState.Missions[len(queuedState.Missions)-1].ID

	if err := run(context.Background(), []string{"orbital", "start-run", repoDir, secondMissionID}, &bytes.Buffer{}); err != nil {
		t.Fatalf("second start-run run() error = %v", err)
	}

	var output bytes.Buffer
	if err := run(context.Background(), []string{"orbital", "approve", repoDir, secondMissionID}, &output); err != nil {
		t.Fatalf("second approve run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(approve JSON) error = %v; output = %q", err, output.String())
	}

	secondMission := state.Missions[len(state.Missions)-1]
	if secondMission.Status != domain.MissionStatusApplied {
		t.Fatalf("second mission status = %q, want %q", secondMission.Status, domain.MissionStatusApplied)
	}
}

func TestRejectMissionPatchRejectsPendingPatch(t *testing.T) {
	repoDir, missionID := prepareStartedDemoMission(t)

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "reject", repoDir, missionID}, &output)
	if err != nil {
		t.Fatalf("reject run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(reject JSON) error = %v; output = %q", err, output.String())
	}

	if state.Missions[0].Status != domain.MissionStatusRejected {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusRejected)
	}
	if state.PatchProposals[0].Status != domain.PatchStatusRejected {
		t.Fatalf("patch status = %q, want %q", state.PatchProposals[0].Status, domain.PatchStatusRejected)
	}

	packageJSON, err := os.ReadFile(filepath.Join(repoDir, "package.json"))
	if err != nil {
		t.Fatalf("ReadFile(package.json) error = %v", err)
	}
	if bytes.Contains(packageJSON, []byte(`"version": "0.1.0"`)) {
		t.Fatalf("package.json was changed after rejection: %s", packageJSON)
	}
}

func TestVerifyMissionRunsCommandAndMarksMissionVerified(t *testing.T) {
	repoDir, missionID := prepareAppliedDemoMission(t)

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "verify", repoDir, missionID, "printf verified"}, &output)
	if err != nil {
		t.Fatalf("verify run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(verify JSON) error = %v; output = %q", err, output.String())
	}

	if state.Missions[0].Status != domain.MissionStatusVerified {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusVerified)
	}
	if len(state.VerificationRuns) != 1 {
		t.Fatalf("expected 1 verification run, got %d", len(state.VerificationRuns))
	}
	if state.VerificationRuns[0].Status != domain.VerificationStatusPassed {
		t.Fatalf("verification status = %q, want %q", state.VerificationRuns[0].Status, domain.VerificationStatusPassed)
	}
	if state.VerificationRuns[0].Output != "verified" {
		t.Fatalf("verification output = %q, want %q", state.VerificationRuns[0].Output, "verified")
	}
}

func TestVerifyMissionFailureMarksMissionFailed(t *testing.T) {
	repoDir, missionID := prepareAppliedDemoMission(t)

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "verify", repoDir, missionID, "printf failed && exit 3"}, &output)
	if err != nil {
		t.Fatalf("verify run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(verify JSON) error = %v; output = %q", err, output.String())
	}

	if state.Missions[0].Status != domain.MissionStatusFailed {
		t.Fatalf("mission status = %q, want %q", state.Missions[0].Status, domain.MissionStatusFailed)
	}
	if state.VerificationRuns[0].Status != domain.VerificationStatusFailed {
		t.Fatalf("verification status = %q, want %q", state.VerificationRuns[0].Status, domain.VerificationStatusFailed)
	}
	if state.VerificationRuns[0].ExitCode == nil || *state.VerificationRuns[0].ExitCode != 3 {
		t.Fatalf("verification exit code = %v, want 3", state.VerificationRuns[0].ExitCode)
	}
}

func TestStatusPrintsSavedWorkflowState(t *testing.T) {
	repoDir := t.TempDir()
	jsonStore := store.NewJSONStore(filepath.Join(repoDir, ".orbital"))
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{ID: "repo_1", Path: repoDir, Name: "demo"},
		},
		Missions: []domain.Mission{
			{ID: "mission_1", RepositoryID: "repo_1", Status: domain.MissionStatusVerified},
		},
		AgentRuns: []domain.AgentRun{
			{ID: "run_1", MissionID: "mission_1", Status: domain.AgentRunStatusCompleted},
		},
		PatchProposals: []domain.PatchProposal{
			{ID: "patch_1", RunID: "run_1", Status: domain.PatchStatusApplied},
		},
		VerificationRuns: []domain.VerificationRun{
			{ID: "verification_1", MissionID: "mission_1", Status: domain.VerificationStatusPassed},
		},
		WorkflowEvents: []domain.WorkflowEvent{
			{
				ID:        "event_1",
				MissionID: "mission_1",
				Type:      domain.WorkflowEventVerificationPassed,
				Message:   "Verification passed.",
			},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "status", repoDir}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	want := "repository: repo_1 (" + repoDir + ")\n" +
		"mission: mission_1 (verified)\n" +
		"  run: run_1 (completed)\n" +
		"    patch: patch_1 (applied)\n" +
		"  verification: verification_1 (passed)\n" +
		"timeline:\n" +
		"- verification_passed: Verification passed.\n"
	if output.String() != want {
		t.Fatalf("status output = %q, want %q", output.String(), want)
	}
}

// unmarshalStreamedState extracts the final state blob from the streamed
// start-run output, which is EVENT:/PATCH:/STATE: prefixed NDJSON lines.
func unmarshalStreamedState(t *testing.T, output string) store.State {
	t.Helper()

	for _, line := range strings.Split(output, "\n") {
		payload, ok := strings.CutPrefix(line, "STATE:")
		if !ok {
			continue
		}
		var state store.State
		if err := json.Unmarshal([]byte(payload), &state); err != nil {
			t.Fatalf("Unmarshal(start-run STATE) error = %v; line = %q", err, payload)
		}
		return state
	}

	t.Fatalf("no STATE line in start-run output = %q", output)
	return store.State{}
}

func prepareStartedDemoMission(t *testing.T) (string, string) {
	t.Helper()

	repoDir := t.TempDir()
	if err := run(context.Background(), []string{"orbital", "demo-fixture", repoDir}, &bytes.Buffer{}); err != nil {
		t.Fatalf("demo-fixture run() error = %v", err)
	}

	var queueOutput bytes.Buffer
	if err := run(context.Background(), []string{"orbital", "queue", repoDir, "add a version command"}, &queueOutput); err != nil {
		t.Fatalf("queue run() error = %v", err)
	}

	var queuedState store.State
	if err := json.Unmarshal(queueOutput.Bytes(), &queuedState); err != nil {
		t.Fatalf("Unmarshal(queue JSON) error = %v", err)
	}

	if err := run(context.Background(), []string{"orbital", "start-run", repoDir, queuedState.Missions[0].ID}, &bytes.Buffer{}); err != nil {
		t.Fatalf("start-run run() error = %v", err)
	}

	return repoDir, queuedState.Missions[0].ID
}

func prepareAppliedDemoMission(t *testing.T) (string, string) {
	t.Helper()

	repoDir, missionID := prepareStartedDemoMission(t)
	if err := run(context.Background(), []string{"orbital", "approve", repoDir, missionID}, &bytes.Buffer{}); err != nil {
		t.Fatalf("approve run() error = %v", err)
	}

	return repoDir, missionID
}

func TestStatusPrintsSavedWorkflowStateAsJSON(t *testing.T) {
	repoDir := t.TempDir()
	jsonStore := store.NewJSONStore(filepath.Join(repoDir, ".orbital"))
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{ID: "repo_1", Path: repoDir, Name: "demo"},
		},
		Missions: []domain.Mission{
			{ID: "mission_1", RepositoryID: "repo_1", Status: domain.MissionStatusVerified},
		},
		AgentRuns: []domain.AgentRun{
			{ID: "run_1", MissionID: "mission_1", Status: domain.AgentRunStatusCompleted},
		},
		PatchProposals: []domain.PatchProposal{
			{ID: "patch_1", RunID: "run_1", Status: domain.PatchStatusApplied},
		},
		VerificationRuns: []domain.VerificationRun{
			{ID: "verification_1", MissionID: "mission_1", Status: domain.VerificationStatusPassed},
		},
		WorkflowEvents: []domain.WorkflowEvent{
			{
				ID:        "event_1",
				MissionID: "mission_1",
				Type:      domain.WorkflowEventVerificationPassed,
				Message:   "Verification passed.",
			},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "status", "--json", repoDir}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	var state store.State
	if err := json.Unmarshal(output.Bytes(), &state); err != nil {
		t.Fatalf("Unmarshal(status JSON) error = %v; output = %q", err, output.String())
	}

	if len(state.Repositories) != 1 || state.Repositories[0].ID != "repo_1" {
		t.Fatalf("repositories = %#v, want repo_1", state.Repositories)
	}
	if len(state.Missions) != 1 || state.Missions[0].ID != "mission_1" {
		t.Fatalf("missions = %#v, want mission_1", state.Missions)
	}
	if len(state.AgentRuns) != 1 || state.AgentRuns[0].ID != "run_1" {
		t.Fatalf("agent runs = %#v, want run_1", state.AgentRuns)
	}
	if len(state.PatchProposals) != 1 || state.PatchProposals[0].ID != "patch_1" {
		t.Fatalf("patch proposals = %#v, want patch_1", state.PatchProposals)
	}
	if len(state.VerificationRuns) != 1 || state.VerificationRuns[0].ID != "verification_1" {
		t.Fatalf("verification runs = %#v, want verification_1", state.VerificationRuns)
	}
	if len(state.WorkflowEvents) != 1 || state.WorkflowEvents[0].ID != "event_1" {
		t.Fatalf("workflow events = %#v, want event_1", state.WorkflowEvents)
	}
}

func TestPrintTimeline(t *testing.T) {
	var output bytes.Buffer

	printTimeline(&output, []domain.WorkflowEvent{
		{
			Type:    domain.WorkflowEventRunStarted,
			Message: "Mock worker started.",
		},
		{
			Type:    domain.WorkflowEventPatchApplied,
			Message: "Patch applied.",
		},
	})

	want := "timeline:\n- run_started: Mock worker started.\n- patch_applied: Patch applied.\n"
	if output.String() != want {
		t.Fatalf("timeline output = %q, want %q", output.String(), want)
	}
}
