package app

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

// pushTimeout bounds a network push so a stalled remote can't wedge the UI.
const pushTimeout = 2 * time.Minute

// GitSyncState reads the branch's position against its upstream. Every field is
// best-effort: a non-git dir, an unborn repo, or a remoteless one all read as
// zero values rather than an error, because the gate only uses this to decide
// what the push control says.
func GitSyncState(repoPath string) domain.GitSync {
	sync := domain.GitSync{Branch: currentGitBranch(repoPath)}
	if !isGitRepo(repoPath) {
		return sync
	}

	sync.Head = gitOutput(repoPath, "rev-parse", "--short", "HEAD")
	sync.Upstream = gitOutput(repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if sync.Upstream != "" {
		sync.Remote, _, _ = strings.Cut(sync.Upstream, "/")
		// --left-right counts both sides of the divergence in one call:
		// "<behind>\t<ahead>" relative to the upstream.
		if counts := gitOutput(repoPath, "rev-list", "--left-right", "--count", sync.Upstream+"...HEAD"); counts != "" {
			fields := strings.Fields(counts)
			if len(fields) == 2 {
				sync.Behind, _ = strconv.Atoi(fields[0])
				sync.Ahead, _ = strconv.Atoi(fields[1])
			}
		}
		return sync
	}

	// No upstream yet: the branch has never been pushed. Name the remote it
	// would go to (origin by convention, else the only one there is) so the UI
	// can offer to publish instead of just refusing.
	remotes := strings.Fields(gitOutput(repoPath, "remote"))
	for _, remote := range remotes {
		if remote == "origin" {
			sync.Remote = remote
			break
		}
	}
	if sync.Remote == "" && len(remotes) > 0 {
		sync.Remote = remotes[0]
	}
	// Everything on an unpublished branch is ahead of nothing.
	if sync.Remote != "" {
		if count := gitOutput(repoPath, "rev-list", "--count", "HEAD"); count != "" {
			sync.Ahead, _ = strconv.Atoi(count)
		}
	}

	return sync
}

// PushRepo sends the current branch to its remote, publishing it (-u) the first
// time. Terminal prompting is disabled so a repo needing credentials fails with
// a message the UI can show instead of hanging on an invisible password prompt.
func PushRepo(repoPath string) (domain.GitSync, error) {
	sync := GitSyncState(repoPath)
	if !isGitRepo(repoPath) {
		return sync, fmt.Errorf("not a git repository: %s", repoPath)
	}
	if sync.Remote == "" {
		return sync, fmt.Errorf("no git remote configured for %s — add one, then push", repoPath)
	}

	ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
	defer cancel()

	args := []string{"push"}
	if sync.Upstream == "" {
		args = append(args, "-u", sync.Remote, "HEAD")
	}
	push := exec.CommandContext(ctx, "git", args...)
	push.Dir = repoPath
	push.Env = append(push.Environ(), "GIT_TERMINAL_PROMPT=0")
	if output, err := push.CombinedOutput(); err != nil {
		return sync, fmt.Errorf("git push: %s", strings.TrimSpace(string(output)))
	}

	return GitSyncState(repoPath), nil
}

// ListBranches names the repo's local branches, most recently committed first:
// the branch you want next is nearly always one you touched lately, so that
// order puts it at the top of the picker.
func ListBranches(repoPath string) []string {
	if !isGitRepo(repoPath) {
		return []string{}
	}
	listed := gitOutput(repoPath, "for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads")
	if listed == "" {
		return []string{}
	}
	return strings.Split(listed, "\n")
}

// SwitchBranch checks out branch, creating it from HEAD when create is set.
//
// It uses `git switch` rather than `git checkout` because switch only ever
// moves branches: a name that happens to match a file can't be read as a path
// and silently throw away that file's uncommitted changes.
//
// Git decides what carrying uncommitted work across is allowed, and its refusal
// is returned verbatim — it names the files in the way, which nothing here could
// improve on.
func SwitchBranch(repoPath, branch string, create bool) (domain.GitSync, error) {
	branch = strings.TrimSpace(branch)
	if !isGitRepo(repoPath) {
		return GitSyncState(repoPath), fmt.Errorf("not a git repository: %s", repoPath)
	}
	// A leading dash would be read as an option instead of a name.
	if branch == "" || strings.HasPrefix(branch, "-") {
		return GitSyncState(repoPath), fmt.Errorf("not a usable branch name: %q", branch)
	}

	args := []string{"switch"}
	if create {
		args = append(args, "-c")
	}
	args = append(args, branch)
	switchCmd := exec.Command("git", args...)
	switchCmd.Dir = repoPath
	if output, err := switchCmd.CombinedOutput(); err != nil {
		return GitSyncState(repoPath), fmt.Errorf("git switch: %s", strings.TrimSpace(string(output)))
	}

	return GitSyncState(repoPath), nil
}

// headIsPushed reports whether HEAD is already contained in the branch's
// upstream. Rewriting such a commit diverges the branch from the remote, and
// the next push is rejected — so the gate stops offering it at all.
func headIsPushed(repoPath string) bool {
	upstream := gitOutput(repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if upstream == "" {
		return false
	}
	contained := exec.Command("git", "merge-base", "--is-ancestor", "HEAD", upstream)
	contained.Dir = repoPath
	return contained.Run() == nil
}

func gitOutput(repoPath string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = repoPath
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
