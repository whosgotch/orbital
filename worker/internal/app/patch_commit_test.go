package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// Two missions build their patches against the same base. Without committing
// each applied patch, landing the first leaves the repo's working tree ahead
// of its index, so the second apply dies with "does not match index".
func TestApplyPatchCommitsEachMissionSoTheNextOneLands(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()
	filePath := filepath.Join(repoDir, "file.txt")

	gitIn(t, repoDir, "init")
	gitIn(t, repoDir, "config", "user.email", "t@t")
	gitIn(t, repoDir, "config", "user.name", "t")

	// The base both missions' patches are built against.
	if err := os.WriteFile(filePath, []byte("a\nb\nc\nd\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "base")

	// Mission one edits line 2, mission two edits line 4 — close enough that
	// mission one's landed change sits inside mission two's context window.
	if err := os.WriteFile(filePath, []byte("a\nB-one\nc\nd\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	diffOne := gitIn(t, repoDir, "diff")
	gitIn(t, repoDir, "checkout", "--", "file.txt")

	if err := os.WriteFile(filePath, []byte("a\nb\nc\nD-two\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	diffTwo := gitIn(t, repoDir, "diff")
	gitIn(t, repoDir, "checkout", "--", "file.txt")

	createdAt := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	state := patchApplyState(repoDir, domain.PatchStatusApproved, createdAt)
	state.PatchProposals[0].Diff = diffOne
	state.Missions[0].Text = "mission one"
	state.Missions = append(state.Missions, domain.Mission{
		ID: "mission_2", RepositoryID: "repo_1", Text: "mission two",
		Status: domain.MissionStatusWaitingApproval, CreatedAt: createdAt, UpdatedAt: createdAt,
	})
	state.AgentRuns = append(state.AgentRuns, domain.AgentRun{
		ID: "run_2", MissionID: "mission_2", WorkerName: "mock",
		Status: domain.AgentRunStatusCompleted, StartedAt: createdAt,
	})
	state.PatchProposals = append(state.PatchProposals, domain.PatchProposal{
		ID: "patch_2", RunID: "run_2", Status: domain.PatchStatusApproved,
		Diff: diffTwo, CreatedAt: createdAt, UpdatedAt: createdAt,
	})
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	patchOne, err := svc.ApplyPatch("patch_1")
	if err != nil {
		t.Fatalf("ApplyPatch(patch_1) error = %v", err)
	}
	patchTwo, err := svc.ApplyPatch("patch_2")
	if err != nil {
		t.Fatalf("ApplyPatch(patch_2) error = %v", err)
	}

	// Each applied patch records the commit it landed as, for the UI's
	// "changes landed" line.
	if patchOne.CommitSubject != "mission one" || patchOne.CommitHash == "" {
		t.Fatalf("patch one commit info = %+v, want subject %q and a non-empty hash", patchOne, "mission one")
	}
	if patchTwo.CommitSubject != "mission two" || patchTwo.CommitHash == "" {
		t.Fatalf("patch two commit info = %+v, want subject %q and a non-empty hash", patchTwo, "mission two")
	}
	if patchOne.CommitHash == patchTwo.CommitHash {
		t.Fatalf("patch one and patch two recorded the same commit hash %q", patchOne.CommitHash)
	}

	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "a\nB-one\nc\nD-two\ne\nf\ng\n" {
		t.Fatalf("merged content = %q, want both missions' edits", string(content))
	}

	// Each mission landed as its own commit and left the tree clean.
	log := gitIn(t, repoDir, "log", "--pretty=%s")
	if lines := strings.Split(strings.TrimSpace(log), "\n"); len(lines) != 3 ||
		lines[0] != "mission two" || lines[1] != "mission one" {
		t.Fatalf("git log = %q, want mission two / mission one / base", log)
	}
	if status := strings.TrimSpace(gitIn(t, repoDir, "status", "--porcelain")); status != "" {
		t.Fatalf("working tree not clean after applies: %q", status)
	}
}

// When the patch's change already matches HEAD (a re-apply of already-landed
// work), commitApplied has nothing to commit — CommitHash/CommitSubject on the
// patch proposal stay empty rather than reporting a commit that didn't happen.
func TestApplyPatchLeavesCommitFieldsEmptyWhenNothingToCommit(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()
	filePath := filepath.Join(repoDir, "file.txt")

	gitIn(t, repoDir, "init")
	gitIn(t, repoDir, "config", "user.email", "t@t")
	gitIn(t, repoDir, "config", "user.name", "t")

	if err := os.WriteFile(filePath, []byte("before\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "base")

	// The patch's target content is already committed, as if applied before —
	// its diff has nothing left to land.
	if err := os.WriteFile(filePath, []byte("after\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "already applied")

	createdAt := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	if err := jsonStore.Save(patchApplyState(repoDir, domain.PatchStatusApproved, createdAt)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	patch, err := svc.ApplyPatch("patch_1")
	if err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
	if patch.CommitHash != "" || patch.CommitSubject != "" {
		t.Fatalf("commit info = %+v, want both empty (nothing to commit)", patch)
	}
}
