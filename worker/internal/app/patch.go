package app

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func (s *Service) MergePatches(runIDs []string) (*domain.PatchProposal, error) {
	now := time.Now().UTC()
	merged := domain.PatchProposal{
		ID:        fmt.Sprintf("patch_%d", now.UnixNano()),
		RunID:     runIDs[0],
		Status:    domain.PatchStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}

	_, err := s.store.Update(func(state *store.State) error {
		merging := make(map[string]bool, len(runIDs))
		var diffs []string
		var missionID string
		for _, runID := range runIDs {
			merging[runID] = true
			runIndex := findRunIndex(state.AgentRuns, runID)
			if runIndex == -1 {
				continue
			}
			if missionID == "" {
				missionID = state.AgentRuns[runIndex].MissionID
			}
			for _, patch := range state.PatchProposals {
				if patch.RunID == runID && patch.Status == domain.PatchStatusPending {
					// Trim only trailing newlines so each file section starts on a
					// fresh line; a leading space on a context line stays intact.
					diffs = append(diffs, strings.TrimRight(patch.Diff, "\n"))
				}
			}
		}

		if len(diffs) == 0 {
			return fmt.Errorf("no pending patches found for the given runs")
		}

		// Join the file sections with a newline and end with one, so `git apply`
		// sees a well-formed patch (a missing final newline reads as corrupt).
		merged.Diff = strings.Join(diffs, "\n") + "\n"

		// Fold the child patches into the one merged patch so a single pending
		// patch reaches the gate (the approve flow resolves one patch per mission).
		remaining := make([]domain.PatchProposal, 0, len(state.PatchProposals))
		for _, patch := range state.PatchProposals {
			if merging[patch.RunID] && patch.Status == domain.PatchStatusPending {
				continue
			}
			remaining = append(remaining, patch)
		}
		state.PatchProposals = append(remaining, merged)
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			missionID, runIDs[0], domain.WorkflowEventPatchesMerged,
			fmt.Sprintf("Merged patches from %d child runs.", len(runIDs)), "", now,
		))

		if missionIndex := findMissionIndex(state.Missions, missionID); missionIndex != -1 {
			state.Missions[missionIndex].Status = domain.MissionStatusWaitingApproval
			state.Missions[missionIndex].UpdatedAt = now
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return &merged, nil
}

func (s *Service) ApprovePatch(patchID string) (*domain.PatchProposal, error) {
	return s.updatePatchDecision(
		patchID,
		domain.PatchStatusApproved,
		domain.MissionStatusApproved,
		domain.WorkflowEventPatchApproved,
		"Patch approved.",
	)
}

func (s *Service) RejectPatch(patchID string) (*domain.PatchProposal, error) {
	return s.updatePatchDecision(
		patchID,
		domain.PatchStatusRejected,
		domain.MissionStatusRejected,
		domain.WorkflowEventPatchRejected,
		"Patch rejected.",
	)
}

func (s *Service) ApplyPatch(patchID string) (*domain.PatchProposal, error) {
	var result domain.PatchProposal
	_, err := s.store.Update(func(state *store.State) error {
		patchIndex := findPatchIndex(state.PatchProposals, patchID)
		if patchIndex == -1 {
			return fmt.Errorf("patch proposal not found: %s", patchID)
		}

		patch := state.PatchProposals[patchIndex]
		if patch.Status != domain.PatchStatusApproved {
			return fmt.Errorf("patch proposal must be approved before applying: %s", patchID)
		}

		runIndex := findRunIndex(state.AgentRuns, patch.RunID)
		if runIndex == -1 {
			return fmt.Errorf("agent run not found: %s", patch.RunID)
		}

		missionIndex := findMissionIndex(state.Missions, state.AgentRuns[runIndex].MissionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", state.AgentRuns[runIndex].MissionID)
		}

		repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID)
		if repositoryIndex == -1 {
			return fmt.Errorf("repository not found: %s", state.Missions[missionIndex].RepositoryID)
		}

		repoPath := state.Repositories[repositoryIndex].Path
		chatRun := state.AgentRuns[runIndex]
		// A live chat agent (one that owns a session) keeps working in its own
		// worktree, which already holds the exact desired file contents. Land its
		// turn by copying those files straight into the repo rather than replaying
		// a diff — that sidesteps git-apply's context/index checks, which a
		// re-applied cumulative diff trips over ("does not match index"). Other
		// runs (mock, manager children) still apply their diff the normal way.
		if strings.TrimSpace(patch.Diff) != "" {
			if chatRun.SessionID != "" && worktreeExists(chatRun.WorktreePath) {
				if err := applyFromWorktree(repoPath, chatRun.WorktreePath, patch.Diff); err != nil {
					return err
				}
			} else if err := applyDiff(repoPath, patch.Diff); err != nil {
				return err
			}
			// Land the applied change as a real commit so the repo's HEAD and
			// index advance with each mission. Without it the working tree
			// drifts from the index and the next mission's apply dies with
			// "does not match index" — and new run worktrees would branch from
			// a stale HEAD that lacks the missions already landed.
			if err := commitApplied(repoPath, patch.Diff, state.Missions[missionIndex].Text); err != nil {
				return err
			}
		}

		// The approved work has landed in the main tree, so this mission's isolated
		// worktrees are disposable — except the live chat agent: keep its worktree
		// and re-baseline it to the just-applied state, so its next turn proposes an
		// incremental diff instead of re-proposing what we already landed.
		missionID := state.AgentRuns[runIndex].MissionID
		for _, run := range state.AgentRuns {
			if run.MissionID != missionID {
				continue
			}
			if run.ID == chatRun.ID && chatRun.SessionID != "" {
				rebaselineWorktree(run.WorktreePath)
				continue
			}
			removeRunWorktree(repoPath, run)
		}

		now := time.Now().UTC()
		state.PatchProposals[patchIndex].Status = domain.PatchStatusApplied
		state.PatchProposals[patchIndex].UpdatedAt = now
		state.Missions[missionIndex].Status = domain.MissionStatusApplied
		state.Missions[missionIndex].UpdatedAt = now
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			state.Missions[missionIndex].ID,
			patch.RunID,
			domain.WorkflowEventPatchApplied,
			"Patch applied.",
			"",
			now,
		))

		result = state.PatchProposals[patchIndex]
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &result, nil
}

// applyDiff lands a patch on the repo working tree. It tries a strict apply
// first (which also covers non-git scratch dirs the mock worker uses), and only
// when that fails — typically because the run's isolated worktree base has
// diverged from the main tree — retries with a blob-based 3-way merge. The
// worktree shares the object store, so the base blobs the merge needs are local.
func applyDiff(repoPath string, diff string) error {
	strict := exec.Command("git", "apply")
	strict.Dir = repoPath
	strict.Stdin = strings.NewReader(diff)
	if _, err := strict.CombinedOutput(); err == nil {
		return nil
	}

	if patchAlreadyApplied(repoPath, diff) {
		return nil
	}

	// The 3-way merge refuses to touch a file whose working-tree content
	// differs from the index ("does not match index") — the exact state
	// leftover uncommitted edits produce. Stage the patch's own files first so
	// the merge sees one consistent "ours" side; the leftovers then ride along
	// into the mission's commit instead of wedging every future apply.
	stagePatchPaths(repoPath, diff)

	merge := exec.Command("git", "apply", "--3way")
	merge.Dir = repoPath
	merge.Stdin = strings.NewReader(diff)
	output, err := merge.CombinedOutput()
	if err == nil {
		return nil
	}

	return fmt.Errorf("apply patch: %w: %s", err, strings.TrimSpace(string(output)))
}

// stagePatchPaths aligns the index with the working tree for the files a diff
// touches. Best-effort: non-git dirs and unborn repos just skip.
func stagePatchPaths(repoPath string, diff string) {
	paths := make([]string, 0)
	for _, change := range changedFiles(diff) {
		paths = append(paths, change.path)
	}
	if len(paths) == 0 {
		return
	}
	add := exec.Command("git", append([]string{"add", "-A", "--"}, paths...)...)
	add.Dir = repoPath
	_ = add.Run()
}

// commitApplied records an applied patch as a commit on the target repo.
// Staging is limited to the patch's own files, so a user's unrelated
// work-in-progress is never swept into a mission's commit. Skips silently for
// non-git scratch dirs (the mock worker) and when the patch changed nothing.
func commitApplied(repoPath, diff, missionText string) error {
	if !isGitRepo(repoPath) {
		return nil
	}

	paths := make([]string, 0)
	for _, change := range changedFiles(diff) {
		paths = append(paths, change.path)
	}
	if len(paths) == 0 {
		return nil
	}

	add := exec.Command("git", append([]string{"add", "-A", "--"}, paths...)...)
	add.Dir = repoPath
	if output, err := add.CombinedOutput(); err != nil {
		return fmt.Errorf("commit applied patch (add): %w: %s", err, strings.TrimSpace(string(output)))
	}

	// Nothing to commit when the patch's files already match HEAD (re-apply).
	unchanged := exec.Command("git", append([]string{"diff", "--quiet", "HEAD", "--"}, paths...)...)
	unchanged.Dir = repoPath
	if unchanged.Run() == nil {
		return nil
	}

	// Committing by pathspec takes exactly these files' current content, so
	// anything else the user staged stays staged and out of this commit.
	commit := exec.Command("git", append([]string{
		"-c", "user.email=orbital@local", "-c", "user.name=Orbital",
		"commit", "-m", commitSubject(missionText), "--"}, paths...)...)
	commit.Dir = repoPath
	if output, err := commit.CombinedOutput(); err != nil {
		return fmt.Errorf("commit applied patch: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func isGitRepo(repoPath string) bool {
	cmd := exec.Command("git", "rev-parse", "--is-inside-work-tree")
	cmd.Dir = repoPath
	return cmd.Run() == nil
}

// commitSubject turns a mission's text into a git subject line: first line
// only, capped so history stays scannable.
func commitSubject(missionText string) string {
	subject := strings.TrimSpace(missionText)
	if index := strings.IndexByte(subject, '\n'); index != -1 {
		subject = strings.TrimSpace(subject[:index])
	}
	if subject == "" {
		subject = "orbital: apply mission patch"
	}
	if len(subject) > 72 {
		subject = subject[:69] + "..."
	}
	return subject
}

func worktreeExists(worktreePath string) bool {
	if strings.TrimSpace(worktreePath) == "" {
		return false
	}
	info, err := os.Stat(worktreePath)
	return err == nil && info.IsDir()
}

// applyFromWorktree lands a chat agent's turn by copying the files its diff
// touched straight from the agent's worktree into the repo (and removing files
// the diff deletes). Because it never replays hunks, it can't fail on context or
// index mismatch — it just makes the repo's changed files match the worktree.
func applyFromWorktree(repoPath, worktreePath, diff string) error {
	for _, change := range changedFiles(diff) {
		dst := filepath.Join(repoPath, change.path)
		if change.deleted {
			if err := os.Remove(dst); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("apply (remove %s): %w", change.path, err)
			}
			continue
		}

		src := filepath.Join(worktreePath, change.path)
		data, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("apply (read %s): %w", change.path, err)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return fmt.Errorf("apply (mkdir %s): %w", change.path, err)
		}
		mode := os.FileMode(0o644)
		if info, statErr := os.Stat(src); statErr == nil {
			mode = info.Mode()
		}
		if err := os.WriteFile(dst, data, mode); err != nil {
			return fmt.Errorf("apply (write %s): %w", change.path, err)
		}
	}
	return nil
}

type changedFile struct {
	path    string
	deleted bool
}

// changedFiles reads the set of files a unified diff touches from its file
// headers: a `+++ /dev/null` marks a deletion (path comes from the `---` line),
// otherwise the `+++ b/<path>` names the file to copy from the worktree.
func changedFiles(diff string) []changedFile {
	var out []changedFile
	var oldPath string
	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "--- "):
			oldPath = stripDiffPathPrefix(strings.TrimPrefix(line, "--- "))
		case strings.HasPrefix(line, "+++ "):
			newPath := stripDiffPathPrefix(strings.TrimPrefix(line, "+++ "))
			if newPath == "/dev/null" {
				out = append(out, changedFile{path: oldPath, deleted: true})
			} else {
				out = append(out, changedFile{path: newPath})
			}
		}
	}
	return out
}

func stripDiffPathPrefix(path string) string {
	path = strings.TrimSpace(path)
	if path == "/dev/null" {
		return path
	}
	if strings.HasPrefix(path, "a/") || strings.HasPrefix(path, "b/") {
		return path[2:]
	}
	return path
}

func patchAlreadyApplied(repoPath string, diff string) bool {
	cmd := exec.Command("git", "apply", "--reverse", "--check")
	cmd.Dir = repoPath
	cmd.Stdin = strings.NewReader(diff)
	return cmd.Run() == nil
}

func (s *Service) updatePatchDecision(patchID string, patchStatus domain.PatchStatus, missionStatus domain.MissionStatus, eventType domain.WorkflowEventType, message string) (*domain.PatchProposal, error) {
	var result domain.PatchProposal
	_, err := s.store.Update(func(state *store.State) error {
		patchIndex := findPatchIndex(state.PatchProposals, patchID)
		if patchIndex == -1 {
			return fmt.Errorf("patch proposal not found: %s", patchID)
		}

		if state.PatchProposals[patchIndex].Status != domain.PatchStatusPending {
			return fmt.Errorf("patch proposal must be pending before decision: %s", patchID)
		}

		runIndex := findRunIndex(state.AgentRuns, state.PatchProposals[patchIndex].RunID)
		if runIndex == -1 {
			return fmt.Errorf("agent run not found: %s", state.PatchProposals[patchIndex].RunID)
		}

		missionIndex := findMissionIndex(state.Missions, state.AgentRuns[runIndex].MissionID)
		if missionIndex == -1 {
			return fmt.Errorf("mission not found: %s", state.AgentRuns[runIndex].MissionID)
		}

		// A rejected mission abandons its work, so tear down every worktree its
		// runs created (manager + each parallel child) now. An approved one keeps
		// them until ApplyPatch lands the diff.
		if patchStatus == domain.PatchStatusRejected {
			if repositoryIndex := findRepositoryIndex(state.Repositories, state.Missions[missionIndex].RepositoryID); repositoryIndex != -1 {
				repoPath := state.Repositories[repositoryIndex].Path
				missionID := state.AgentRuns[runIndex].MissionID
				for _, run := range state.AgentRuns {
					if run.MissionID == missionID {
						removeRunWorktree(repoPath, run)
					}
				}
			}
		}

		now := time.Now().UTC()
		state.PatchProposals[patchIndex].Status = patchStatus
		state.PatchProposals[patchIndex].UpdatedAt = now
		state.Missions[missionIndex].Status = missionStatus
		state.Missions[missionIndex].UpdatedAt = now
		state.WorkflowEvents = append(state.WorkflowEvents, newWorkflowEvent(
			state.Missions[missionIndex].ID,
			state.AgentRuns[runIndex].ID,
			eventType,
			message,
			"",
			now,
		))

		result = state.PatchProposals[patchIndex]
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &result, nil
}

func findPatchIndex(patches []domain.PatchProposal, patchID string) int {
	for index, patch := range patches {
		if patch.ID == patchID {
			return index
		}
	}

	return -1
}

func findRunIndex(runs []domain.AgentRun, runID string) int {
	for index, run := range runs {
		if run.ID == runID {
			return index
		}
	}

	return -1
}
