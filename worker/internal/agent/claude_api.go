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
func callClaudeAgentic(ctx context.Context, repoPath, prompt string, onStep func(msg string)) (string, error) {
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
					onStep(truncate(block.Text, 220))
				}
				if block.Type == "tool_use" {
					onStep(describeToolUse(block.Name, block.Input))
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
