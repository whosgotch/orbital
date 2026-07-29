package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func runWorktreePath(repoPath, runID string) string {
	return filepath.Join(repoPath, ".orbital", "worktrees", runID)
}

// createRunWorktree adds an isolated git worktree for a run at a detached HEAD,
// so an agent's edits never touch the user's own working tree before the patch
// is approved, and parallel agents never share one tree.
//
// It returns an empty path and no error only for a directory git doesn't manage
// (the scratch dirs the local-command worker uses), where there is no tree to
// protect. In a real repository the worktree is mandatory: failing to create one
// is an error, never a fallback to the repo root — running there would edit the
// user's files live, with nothing left to approve.
func createRunWorktree(ctx context.Context, repoPath, runID string) (string, error) {
	if !isGitRepo(repoPath) {
		return "", nil
	}

	worktreePath := runWorktreePath(repoPath, runID)
	if err := os.MkdirAll(filepath.Dir(worktreePath), 0o755); err != nil {
		return "", fmt.Errorf("create worktree directory: %w", err)
	}

	// A stale worktree directory from a crashed run would block `add`.
	removeWorktreeAt(repoPath, worktreePath)

	cmd := exec.CommandContext(ctx, "git", "worktree", "add", "--detach", worktreePath, "HEAD")
	cmd.Dir = repoPath
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf(
			"cannot isolate this run: git worktree add failed in %s (a repository with no commits yet can't host one — make an initial commit and re-run): %w: %s",
			repoPath, err, strings.TrimSpace(string(output)),
		)
	}

	return worktreePath, nil
}

// rebaselineWorktree commits a live chat agent's worktree in place, so its HEAD
// advances to the state we just approved. The next `git diff` in that worktree
// then captures only the following turn's changes (an incremental patch), which
// applies cleanly on top of the already-landed work instead of colliding with
// it. Best-effort: a failure here must not fail the apply.
func rebaselineWorktree(worktreePath string) {
	if strings.TrimSpace(worktreePath) == "" {
		return
	}
	add := exec.Command("git", "add", "-A")
	add.Dir = worktreePath
	_ = add.Run()

	commit := exec.Command("git",
		"-c", "user.email=orbital@local", "-c", "user.name=Orbital",
		"commit", "-m", "orbital chat baseline", "--allow-empty")
	commit.Dir = worktreePath
	_ = commit.Run()
}

func removeRunWorktree(repoPath string, run domain.AgentRun) {
	if run.WorktreePath == "" {
		return
	}
	removeWorktreeAt(repoPath, run.WorktreePath)
}

func removeWorktreeAt(repoPath, worktreePath string) {
	if strings.TrimSpace(worktreePath) == "" {
		return
	}

	remove := exec.Command("git", "worktree", "remove", "--force", worktreePath)
	remove.Dir = repoPath
	_ = remove.Run()

	// Ensure the directory is gone even if git declined, then drop the stale
	// administrative entry so a future `add` at the same path succeeds.
	_ = os.RemoveAll(worktreePath)

	prune := exec.Command("git", "worktree", "prune")
	prune.Dir = repoPath
	_ = prune.Run()
}
