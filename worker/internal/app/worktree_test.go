package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// recordingWorker captures the working directory it was handed, so tests can
// assert the run executed inside an isolated worktree rather than the repo root.
type recordingWorker struct{ seen *string }

func (w recordingWorker) Name() string                  { return "recording" }
func (w recordingWorker) Profile() agent.WorkerProfile  { return agent.WorkerProfile{Name: w.Name()} }
func (w recordingWorker) CheckAvailable(ctx context.Context) (*agent.WorkerInfo, error) {
	return &agent.WorkerInfo{Name: w.Name(), Available: true}, nil
}
func (w recordingWorker) Supports(ctx context.Context, r agent.RunRequest) agent.SupportResult {
	return agent.SupportResult{Supported: true}
}
func (w recordingWorker) StartRun(ctx context.Context, r agent.RunRequest) (<-chan agent.RunEvent, error) {
	*w.seen = r.RepoPath
	events := make(chan agent.RunEvent)
	close(events)
	return events, nil
}
func (w recordingWorker) CancelRun(ctx context.Context, runID string) error { return nil }

func gitInit(t *testing.T, dir string) {
	t.Helper()
	for _, args := range [][]string{
		{"init"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
}

func TestStartAgentRunExecutesInIsolatedWorktree(t *testing.T) {
	repoDir := t.TempDir()
	gitInit(t, repoDir)

	var seenDir string
	registry := agent.NewWorkerRegistry()
	registry.Register(recordingWorker{seen: &seenDir})
	jsonStore := store.NewJSONStore(filepath.Join(repoDir, ".orbital"))
	svc := NewServiceWithWorkerRegistry(jsonStore, registry)

	if _, err := jsonStore.Update(func(state *store.State) error {
		state.Repositories = []domain.Repository{{ID: "repo_1", Path: repoDir, Name: "demo"}}
		state.Missions = []domain.Mission{{ID: "mission_1", RepositoryID: "repo_1", Text: "do work", Status: domain.MissionStatusRunning}}
		return nil
	}); err != nil {
		t.Fatalf("seed state: %v", err)
	}

	if _, err := svc.StartAgentRun(context.Background(), "mission_1", "recording"); err != nil {
		t.Fatalf("StartAgentRun error = %v", err)
	}

	if !strings.Contains(seenDir, filepath.Join(".orbital", "worktrees")) {
		t.Fatalf("worker ran in %q, want a worktree under .orbital/worktrees", seenDir)
	}
	if seenDir == repoDir {
		t.Fatal("worker ran in the repo root instead of an isolated worktree")
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	run := state.AgentRuns[len(state.AgentRuns)-1]
	if run.WorktreePath != seenDir {
		t.Fatalf("run.WorktreePath = %q, want %q", run.WorktreePath, seenDir)
	}
	if _, err := os.Stat(seenDir); err != nil {
		t.Fatalf("worktree dir missing: %v", err)
	}
}
