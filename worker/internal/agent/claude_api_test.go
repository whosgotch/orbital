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
	turn := scanAgenticStream(strings.NewReader(stream), func(kind, msg string) {
		kinds = append(kinds, kind)
		msgs = append(msgs, msg)
	})

	if turn.SessionID != "sess_abc123" {
		t.Fatalf("SessionID = %q, want sess_abc123", turn.SessionID)
	}
	if turn.Summary != "Added a /health route." {
		t.Fatalf("Summary = %q", turn.Summary)
	}
	if len(kinds) != 2 || kinds[0] != "thought" || kinds[1] != "action" {
		t.Fatalf("steps = %v (%v)", kinds, msgs)
	}
	if !strings.Contains(msgs[1], "main.go") {
		t.Errorf("action step should name the edited file: %q", msgs[1])
	}
}

// Thinking blocks are the model's real chain of thought and must reach the
// transcript under their own kind, apart from the narration text blocks.
func TestScanAgenticStreamCapturesThinking(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"The route is missing a handler.\nI should add one."}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Adding the route."}]}}`,
		`{"type":"result","subtype":"success","result":"Done."}`,
	}, "\n")

	var kinds, msgs []string
	scanAgenticStream(strings.NewReader(stream), func(kind, msg string) {
		kinds = append(kinds, kind)
		msgs = append(msgs, msg)
	})

	if len(kinds) != 2 || kinds[0] != "reasoning" || kinds[1] != "thought" {
		t.Fatalf("steps = %v (%v)", kinds, msgs)
	}
	if !strings.Contains(msgs[0], "I should add one.") {
		t.Errorf("reasoning step should keep the whole thought: %q", msgs[0])
	}
}

// The node shows which model did the work, so the resolved model the CLI
// reports must be captured — from the init line, or from an assistant line when
// a resumed turn carries no init.
func TestScanAgenticStreamCapturesModel(t *testing.T) {
	withInit := `{"type":"system","subtype":"init","model":"claude-fable-5","session_id":"s1"}` + "\n" +
		`{"type":"result","subtype":"success","result":"Done."}`
	if got := scanAgenticStream(strings.NewReader(withInit), func(string, string) {}).Model; got != "claude-fable-5" {
		t.Errorf("Model = %q, want claude-fable-5", got)
	}

	resumed := `{"type":"assistant","message":{"model":"claude-opus-5","content":[{"type":"text","text":"ok"}]}}`
	if got := scanAgenticStream(strings.NewReader(resumed), func(string, string) {}).Model; got != "claude-opus-5" {
		t.Errorf("Model = %q, want claude-opus-5 from the assistant line", got)
	}

	noModel := `{"type":"result","subtype":"success","result":"Done."}`
	if got := scanAgenticStream(strings.NewReader(noModel), func(string, string) {}).Model; got != "" {
		t.Errorf("Model = %q, want empty when the stream never names one", got)
	}
}

// scanAgenticStream must distill the CLI's usage records into a RunUsage:
// context fill is the fullest assistant input (cache included), and the totals
// come from the terminal result line.
func TestScanAgenticStreamCapturesUsage(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"assistant","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":900,"output_tokens":20},"content":[{"type":"text","text":"ok"}]}}`,
		`{"type":"assistant","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":4800,"output_tokens":50},"content":[{"type":"text","text":"done"}]}}`,
		`{"type":"result","subtype":"success","result":"Done.","total_cost_usd":0.12,"usage":{"input_tokens":300,"cache_read_input_tokens":5700,"output_tokens":70}}`,
	}, "\n")

	usage := scanAgenticStream(strings.NewReader(stream), func(string, string) {}).Usage
	if usage == nil {
		t.Fatal("usage is nil, want a parsed RunUsage")
	}
	// Fullest assistant input: 200 + 4800 = 5000.
	if usage.ContextTokens != 5000 {
		t.Errorf("ContextTokens = %d, want 5000", usage.ContextTokens)
	}
	// Result input total: 300 + 5700 = 6000.
	if usage.InputTokens != 6000 {
		t.Errorf("InputTokens = %d, want 6000", usage.InputTokens)
	}
	if usage.OutputTokens != 70 {
		t.Errorf("OutputTokens = %d, want 70", usage.OutputTokens)
	}
	if usage.TotalTokens != 6070 {
		t.Errorf("TotalTokens = %d, want 6070", usage.TotalTokens)
	}
	if usage.CostUSD != 0.12 {
		t.Errorf("CostUSD = %v, want 0.12", usage.CostUSD)
	}
}

// A stream with no usage records at all must not fabricate a zero-valued
// RunUsage — nil means "unknown", which the UI renders as no badge.
func TestScanAgenticStreamNoUsage(t *testing.T) {
	stream := `{"type":"result","subtype":"success","result":"Done."}`
	if usage := scanAgenticStream(strings.NewReader(stream), func(string, string) {}).Usage; usage != nil {
		t.Errorf("usage = %+v, want nil when the stream carries no usage", usage)
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
