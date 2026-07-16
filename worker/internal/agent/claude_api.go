package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// streamJSONLine is one line of `claude --output-format stream-json` output.
type streamJSONLine struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	Result    string `json:"result"`
	SessionID string `json:"session_id"`
	Message   struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	} `json:"message"`
}

// callClaudeAgentic runs Claude in the repo with edit permissions so it can
// modify files directly. It streams Claude's actions (text, tool use) to onStep
// as they happen, and returns Claude's final summary plus the CLI session id so
// the caller can resume the same conversation on a later turn. The actual file
// changes are captured separately via git diff.
//
// When resumeSessionID is non-empty, the prompt continues that existing session
// (`claude --resume <id>`) instead of starting fresh — this is what turns a run
// into a live, multi-turn chat. onStep receives each streamed step as
// ("thought", reasoning text) for Claude's own narration or ("action", tool
// description) for an edit/command it runs.
func callClaudeAgentic(ctx context.Context, repoPath, resumeSessionID, model, prompt string, onStep func(kind, msg string)) (string, string, error) {
	args := []string{"--print",
		"--permission-mode", "acceptEdits",
		"--output-format", "stream-json", "--verbose"}
	if resumeSessionID != "" {
		args = append(args, "--resume", resumeSessionID)
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	args = append(args, prompt)

	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = repoPath

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", "", err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return "", "", fmt.Errorf("claude CLI start: %w", err)
	}

	summary, sessionID := scanAgenticStream(stdout, onStep)

	if err := cmd.Wait(); err != nil {
		return "", "", fmt.Errorf("claude CLI: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return summary, sessionID, nil
}

// scanAgenticStream reads `claude --output-format stream-json` lines, forwarding
// Claude's narration and tool calls to onStep, and returns the final summary and
// the session id (captured from whichever line carries it). Kept separate from
// the exec plumbing so it can be tested against a captured stream fixture.
func scanAgenticStream(r io.Reader, onStep func(kind, msg string)) (summary, sessionID string) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		var line streamJSONLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}
		if line.SessionID != "" {
			sessionID = line.SessionID
		}
		switch line.Type {
		case "assistant":
			for _, block := range line.Message.Content {
				if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
					// Preserve Claude's full reasoning so the Agent transcript can
					// show how it thinks, not a clipped one-liner.
					onStep("thought", strings.TrimSpace(block.Text))
				}
				if block.Type == "tool_use" {
					onStep("action", describeToolUse(block.Name, block.Input))
				}
			}
		case "result":
			summary = strings.TrimSpace(line.Result)
		}
	}
	return summary, sessionID
}

// QueryClaudeInRepoStreaming asks Claude a question it can answer by reading
// the repo, returning its plain-text answer. It runs in plan permission mode —
// Claude may read/search files but cannot edit them — so it's safe for
// repo-aware planning. Its steps are made visible via stream-json output, so
// the caller can surface Claude's narration and tool calls live through onStep
// while the answer is being produced. Returns the final result text.
func QueryClaudeInRepoStreaming(ctx context.Context, repoPath, model, prompt string, onStep func(kind, msg string)) (string, error) {
	if !claudeCLIAvailable() {
		return "", fmt.Errorf("claude CLI not found on PATH")
	}

	args := []string{"--print",
		"--permission-mode", "plan",
		"--output-format", "stream-json", "--verbose"}
	if model != "" {
		args = append(args, "--model", model)
	}
	args = append(args, prompt)

	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = repoPath

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("claude CLI start: %w", err)
	}

	result, _ := scanAgenticStream(stdout, onStep)

	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("claude CLI: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return result, nil
}

func describeToolUse(name string, input json.RawMessage) string {
	var fields struct {
		FilePath string `json:"file_path"`
		Path     string `json:"path"`
		Command  string `json:"command"`
		Pattern  string `json:"pattern"`
		URL      string `json:"url"`
	}
	_ = json.Unmarshal(input, &fields)

	target := fields.FilePath
	if target == "" {
		target = fields.Path
	}

	// Claude Code's own call notation — Tool(target) — so the transcript reads
	// like the terminal, not like chat.
	switch name {
	case "Read":
		return "Read(" + base(target) + ")"
	case "Edit", "MultiEdit":
		return "Update(" + base(target) + ")"
	case "Write":
		return "Write(" + base(target) + ")"
	case "Bash":
		return "Bash(" + truncate(fields.Command, 120) + ")"
	case "Glob", "Grep":
		return "Search(" + fields.Pattern + ")"
	case "WebFetch", "WebSearch":
		return name + "(" + truncate(fields.URL+fields.Pattern, 80) + ")"
	default:
		if target != "" {
			return name + "(" + base(target) + ")"
		}
		return name
	}
}

func base(path string) string {
	if path == "" {
		return ""
	}
	return filepath.Base(path)
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ensureGitRepo makes sure repoPath is a git repo so changes can be captured
// as a diff and applied later. If it isn't, it inits one and commits a baseline
// so subsequent diffs reflect only the agent's changes.
func ensureGitRepo(ctx context.Context, repoPath string) error {
	check := exec.CommandContext(ctx, "git", "rev-parse", "--is-inside-work-tree")
	check.Dir = repoPath
	if check.Run() == nil {
		// Existing repo: make sure Orbital's own state never surfaces as
		// untracked/intent-to-added noise in the user's git status.
		ensureOrbitalExcluded(ctx, repoPath)
		return nil
	}

	// Keep Orbital's own state out of the baseline so it never appears in diffs.
	if err := os.WriteFile(filepath.Join(repoPath, ".gitignore"), []byte(".orbital/\n"), 0644); err != nil {
		return fmt.Errorf("write .gitignore: %w", err)
	}

	steps := [][]string{
		{"init"},
		{"add", "-A"},
		{"-c", "user.email=orbital@local", "-c", "user.name=Orbital", "commit", "-m", "orbital baseline", "--allow-empty"},
	}
	for _, args := range steps {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = repoPath
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// ensureOrbitalExcluded adds .orbital/ to the repo's local exclude file
// (.git/info/exclude) so Orbital's state and per-run worktrees never show up as
// untracked files. It's local-only — it never touches the user's tracked
// .gitignore — and best-effort: a failure here must not break a run.
func ensureOrbitalExcluded(ctx context.Context, repoPath string) {
	pathCmd := exec.CommandContext(ctx, "git", "rev-parse", "--git-path", "info/exclude")
	pathCmd.Dir = repoPath
	out, err := pathCmd.Output()
	if err != nil {
		return
	}

	excludePath := strings.TrimSpace(string(out))
	if !filepath.IsAbs(excludePath) {
		excludePath = filepath.Join(repoPath, excludePath)
	}

	existing, _ := os.ReadFile(excludePath)
	for _, line := range strings.Split(string(existing), "\n") {
		if strings.TrimSpace(line) == ".orbital/" {
			return
		}
	}

	if err := os.MkdirAll(filepath.Dir(excludePath), 0755); err != nil {
		return
	}
	content := string(existing)
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += ".orbital/\n"
	_ = os.WriteFile(excludePath, []byte(content), 0644)
}

// captureGitDiff stages intent-to-add for new files (so they appear in the
// diff) and returns the working-tree diff for the repo. ensureGitRepo has
// already excluded .orbital/ via .git/info/exclude, so git add skips Orbital's
// own state instead of intent-adding it into the user's index.
func captureGitDiff(ctx context.Context, repoPath string) (string, error) {
	add := exec.CommandContext(ctx, "git", "add", "-A", "-N")
	add.Dir = repoPath
	if out, err := add.CombinedOutput(); err != nil {
		return "", fmt.Errorf("git add -N: %w: %s", err, strings.TrimSpace(string(out)))
	}

	diff := exec.CommandContext(ctx, "git", "diff", "--", ".", ":(exclude).orbital")
	diff.Dir = repoPath
	var stderr bytes.Buffer
	diff.Stderr = &stderr
	out, err := diff.Output()
	if err != nil {
		return "", fmt.Errorf("git diff: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

func claudeCLIAvailable() bool {
	_, err := exec.LookPath("claude")
	return err == nil
}
