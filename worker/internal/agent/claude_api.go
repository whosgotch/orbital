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

	"github.com/whosgotch/orbital/worker/internal/domain"
)

// usageRecord is the `usage` object the claude CLI attaches to assistant
// messages and the final result line. cache_read/cache_creation count toward
// the context window and the bill just like plain input tokens do, so any
// "input" figure has to add them in.
type usageRecord struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

// inputTotal is the full prompt size for a request: fresh input plus the cached
// tokens the model still had to be handed. This is what fills the context window.
func (u usageRecord) inputTotal() int {
	return u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
}

// streamJSONLine is one line of `claude --output-format stream-json` output.
type streamJSONLine struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	Result  string `json:"result"`
	// Model on the init line is the model the CLI resolved for this turn.
	Model        string  `json:"model"`
	SessionID    string  `json:"session_id"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	// Usage on the terminal result line is cumulative for the whole turn.
	Usage   *usageRecord `json:"usage"`
	Message struct {
		// Model on an assistant line names the model that produced it.
		Model string `json:"model"`
		// Usage on an assistant line is that one API call's usage; the last one
		// seen reflects the final, fullest context of the turn.
		Usage   *usageRecord `json:"usage"`
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
func callClaudeAgentic(ctx context.Context, repoPath, resumeSessionID, model, effort, prompt string, onStep func(kind, msg string)) (streamResult, error) {
	args := []string{"--print",
		"--permission-mode", "acceptEdits",
		// WebSearch/WebFetch sit behind their own permission gate that acceptEdits
		// doesn't cover; headless runs have no TTY to approve it, so without this
		// every search silently fails with "you haven't granted it yet".
		"--allowedTools", "WebSearch,WebFetch",
		"--output-format", "stream-json", "--verbose"}
	if resumeSessionID != "" {
		args = append(args, "--resume", resumeSessionID)
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	if effort != "" {
		args = append(args, "--effort", effort)
	}
	args = append(args, prompt)

	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = repoPath

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return streamResult{}, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return streamResult{}, fmt.Errorf("claude CLI start: %w", err)
	}

	result := scanAgenticStream(stdout, onStep)

	if err := cmd.Wait(); err != nil {
		return streamResult{}, fmt.Errorf("claude CLI: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return result, nil
}

// streamResult is everything one `claude` turn yields beyond its streamed steps.
type streamResult struct {
	Summary   string
	SessionID string
	// Model is the model the CLI actually ran, as it reports on its init line.
	// It is the resolved id, which need not be what we asked for: an alias
	// expands, a `[1m]` suffix falls away, and an empty request resolves to
	// whatever the CLI itself was configured to use.
	Model string
	Usage *domain.RunUsage
}

// scanAgenticStream reads `claude --output-format stream-json` lines, forwarding
// Claude's narration and tool calls to onStep, and returns what the turn yielded
// (summary, session id, resolved model, usage) — each captured from whichever
// line carries it. Kept separate from the exec plumbing so it can be tested
// against a captured stream fixture.
func scanAgenticStream(r io.Reader, onStep func(kind, msg string)) streamResult {
	var result streamResult
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	// contextFill tracks the fullest input seen so far this turn — the final
	// assistant call's prompt size, i.e. how much of the window is occupied.
	contextFill := 0
	for scanner.Scan() {
		var line streamJSONLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}
		if line.SessionID != "" {
			result.SessionID = line.SessionID
		}
		// The init line names the resolved model; an assistant line repeats it,
		// which is the fallback when a resumed turn skips init.
		if line.Model != "" {
			result.Model = line.Model
		} else if line.Message.Model != "" {
			result.Model = line.Message.Model
		}
		switch line.Type {
		case "assistant":
			if line.Message.Usage != nil {
				if fill := line.Message.Usage.inputTotal(); fill > contextFill {
					contextFill = fill
				}
			}
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
			result.Summary = strings.TrimSpace(line.Result)
			if line.Usage != nil {
				input := line.Usage.inputTotal()
				// No per-message usage arrived (older CLI, or streamed differently):
				// the result's own input is the best context-fill estimate we have.
				if contextFill == 0 {
					contextFill = input
				}
				result.Usage = &domain.RunUsage{
					ContextTokens: contextFill,
					InputTokens:   input,
					OutputTokens:  line.Usage.OutputTokens,
					TotalTokens:   input + line.Usage.OutputTokens,
					CostUSD:       line.TotalCostUSD,
				}
			}
		}
	}
	return result
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

	result := scanAgenticStream(stdout, onStep).Summary

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
	if err := appendLineIfMissing(filepath.Join(repoPath, ".gitignore"), ".orbital/"); err != nil {
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

	if err := os.MkdirAll(filepath.Dir(excludePath), 0755); err != nil {
		return
	}
	_ = appendLineIfMissing(excludePath, ".orbital/")
}

// appendLineIfMissing adds line to the file at path, creating it if needed and
// preserving whatever it already held — a folder that is not a repo yet can
// still carry a .gitignore the user wrote.
func appendLineIfMissing(path, line string) error {
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, existingLine := range strings.Split(string(existing), "\n") {
		if strings.TrimSpace(existingLine) == line {
			return nil
		}
	}

	content := string(existing)
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	return os.WriteFile(path, []byte(content+line+"\n"), 0644)
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
