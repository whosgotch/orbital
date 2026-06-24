package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// streamJSONLine is one line of `claude --output-format stream-json` output.
type streamJSONLine struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	Result  string `json:"result"`
	Message struct {
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
// as they happen, and returns Claude's final summary. The actual file changes
// are captured separately via git diff.
// onStep receives each streamed step as ("thought", reasoning text) for Claude's
// own narration or ("action", tool description) for an edit/command it runs.
func callClaudeAgentic(ctx context.Context, repoPath, prompt string, onStep func(kind, msg string)) (string, error) {
	cmd := exec.CommandContext(ctx, "claude", "--print",
		"--permission-mode", "acceptEdits",
		"--output-format", "stream-json", "--verbose",
		prompt)
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

	var summary string
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		var line streamJSONLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
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

	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("claude CLI: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return summary, nil
}

// managerPlan is Claude's decomposition of a mission into the work each
// specialized child agent should carry out.
type managerPlan struct {
	EngineerTask string `json:"engineer_task"`
	ReviewerTask string `json:"reviewer_task"`
}

// callClaudePlan asks Claude to break a mission into an engineering task and a
// review task. It returns the parsed plan, or an error if the CLI fails or the
// response can't be parsed (callers fall back to delegating the raw mission).
func callClaudePlan(ctx context.Context, repoPath, mission string) (managerPlan, error) {
	prompt := fmt.Sprintf(`You are an engineering manager planning how to accomplish a mission in this repository.

Mission: %s

Decompose it into work for two agents that run in sequence on the same code:
1. an Engineer who implements the change, and
2. a Reviewer who refines the engineer's work for correctness, edge cases, and clarity.

Respond with ONLY a JSON object and nothing else:
{"engineer_task": "<what the engineer should implement>", "reviewer_task": "<what the reviewer should check and refine>"}`, mission)

	cmd := exec.CommandContext(ctx, "claude", "--print", "--output-format", "json", prompt)
	cmd.Dir = repoPath
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	out, err := cmd.Output()
	if err != nil {
		return managerPlan{}, fmt.Errorf("claude plan: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	// `--output-format json` wraps the answer in a result envelope.
	text := string(out)
	var envelope struct {
		Result string `json:"result"`
	}
	if json.Unmarshal(out, &envelope) == nil && strings.TrimSpace(envelope.Result) != "" {
		text = envelope.Result
	}

	plan, err := parseManagerPlan(text)
	if err != nil {
		return managerPlan{}, err
	}
	return plan, nil
}

// parseManagerPlan extracts the JSON object from Claude's reply, tolerating
// markdown fences or surrounding prose.
func parseManagerPlan(text string) (managerPlan, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start == -1 || end == -1 || end < start {
		return managerPlan{}, fmt.Errorf("no JSON object in plan response")
	}

	var plan managerPlan
	if err := json.Unmarshal([]byte(text[start:end+1]), &plan); err != nil {
		return managerPlan{}, fmt.Errorf("parse plan: %w", err)
	}
	return plan, nil
}

// describeToolUse renders a concise, human-readable line for a Claude tool call.
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

	switch name {
	case "Read":
		return "📖 Reading " + base(target)
	case "Edit", "MultiEdit", "Write":
		return "✏️ Editing " + base(target)
	case "Bash":
		return "⚡ Running: " + truncate(fields.Command, 120)
	case "Glob", "Grep":
		return "🔍 Searching " + fields.Pattern
	case "WebFetch", "WebSearch":
		return "🌐 " + name + " " + truncate(fields.URL+fields.Pattern, 80)
	default:
		if target != "" {
			return name + " " + base(target)
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

// captureGitDiff stages intent-to-add for new files (so they appear in the
// diff) and returns the working-tree diff for the repo.
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
