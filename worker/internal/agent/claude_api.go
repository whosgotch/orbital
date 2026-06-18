package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

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
