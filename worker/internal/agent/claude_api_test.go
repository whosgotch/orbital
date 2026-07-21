package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// scanAgenticStream must capture the session id (so a run can be resumed as a
// chat) and the final summary, while forwarding narration and tool calls.
func TestScanAgenticStreamCapturesSessionAndSteps(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"system","subtype":"init","session_id":"sess_abc123"}`,
		`{"type":"assistant","session_id":"sess_abc123","message":{"content":[{"type":"text","text":"Adding the route."}]}}`,
		`{"type":"assistant","session_id":"sess_abc123","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/main.go"}}]}}`,
		`{"type":"result","subtype":"success","session_id":"sess_abc123","result":"Added a /health route."}`,
	}, "\n")

	var kinds, msgs []string
	summary, sessionID := scanAgenticStream(strings.NewReader(stream), func(kind, msg string) {
		kinds = append(kinds, kind)
		msgs = append(msgs, msg)
	})

	if sessionID != "sess_abc123" {
		t.Fatalf("sessionID = %q, want sess_abc123", sessionID)
	}
	if summary != "Added a /health route." {
		t.Fatalf("summary = %q", summary)
	}
	if len(kinds) != 2 || kinds[0] != "thought" || kinds[1] != "action" {
		t.Fatalf("steps = %v (%v)", kinds, msgs)
	}
	if !strings.Contains(msgs[1], "main.go") {
		t.Errorf("action step should name the edited file: %q", msgs[1])
	}
}

// Orbital's own .orbital directory must never leak into a captured patch or get
// intent-to-added into the user's index (which showed up as spurious "A
// .orbital/..." entries in git status).
func TestCaptureGitDiffExcludesOrbitalState(t *testing.T) {
	ctx := context.Background()
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.email", "t@t")
	runGit(t, repo, "config", "user.name", "t")
	runGit(t, repo, "commit", "--allow-empty", "-m", "base")

	if err := os.MkdirAll(filepath.Join(repo, ".orbital", "runs"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".orbital", "state.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "real.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := ensureGitRepo(ctx, repo); err != nil {
		t.Fatalf("ensureGitRepo() error = %v", err)
	}

	diff, err := captureGitDiff(ctx, repo)
	if err != nil {
		t.Fatalf("captureGitDiff() error = %v", err)
	}
	if !strings.Contains(diff, "real.go") {
		t.Fatalf("diff should include the real change:\n%s", diff)
	}
	if strings.Contains(diff, ".orbital") {
		t.Fatalf("diff leaked .orbital state:\n%s", diff)
	}

	// .orbital must not be intent-to-added, nor even show as untracked.
	status := runGit(t, repo, "status", "--porcelain")
	if strings.Contains(status, ".orbital") {
		t.Fatalf("git status mentions .orbital, want it excluded:\n%s", status)
	}
}

// A folder that is not a repo yet can still carry a .gitignore the user wrote;
// initializing the baseline must add to it, never replace it.
func TestEnsureGitRepoKeepsExistingGitignore(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("node_modules/\n*.log\n"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := ensureGitRepo(context.Background(), dir); err != nil {
		t.Fatalf("ensureGitRepo() error = %v", err)
	}

	content, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"node_modules/", "*.log", ".orbital/"} {
		if !strings.Contains(string(content), want) {
			t.Fatalf("gitignore lost %q:\n%s", want, content)
		}
	}
}
