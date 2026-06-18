package agent

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// callClaude runs a non-agentic, text-only Claude prompt and returns its output.
// Used for planning/decomposition where we only want a textual answer.
func callClaude(ctx context.Context, system, userMessage string) (string, error) {
	prompt := fmt.Sprintf("<system>\n%s\n</system>\n\n%s", system, userMessage)
	cmd := exec.CommandContext(ctx, "claude", "--print")
	cmd.Stdin = strings.NewReader(prompt)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("claude CLI: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}

// callClaudeAgentic runs Claude in the repo with edit permissions so it can
// modify files directly, then returns Claude's textual summary. The actual
// changes are captured separately via git diff.
func callClaudeAgentic(ctx context.Context, repoPath, prompt string) (string, error) {
	cmd := exec.CommandContext(ctx, "claude", "--print", "--permission-mode", "acceptEdits", prompt)
	cmd.Dir = repoPath
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("claude CLI: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
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

	diff := exec.CommandContext(ctx, "git", "diff")
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

func extractJSONArray(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		if nl := strings.Index(s, "\n"); nl != -1 {
			s = s[nl+1:]
		}
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
	}
	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start != -1 && end > start {
		return s[start : end+1]
	}
	return s
}
