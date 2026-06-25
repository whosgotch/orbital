package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// A patch built against an older base must still land after the repo has moved
// on within the patch's context window: strict git apply fails on the stale
// context, so ApplyPatch falls back to a blob-based 3-way merge that keeps both
// the repo's later change and the patch.
func TestApplyPatchFallsBackToThreeWayMergeOnDivergedTree(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()
	filePath := filepath.Join(repoDir, "file.txt")

	gitIn(t, repoDir, "init")
	gitIn(t, repoDir, "config", "user.email", "t@t")
	gitIn(t, repoDir, "config", "user.name", "t")

	// Base the patch was built against.
	if err := os.WriteFile(filePath, []byte("a\nb\nc\nd\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "base")

	// Patch edits line 4 (real blob ids so the 3-way merge has its base).
	if err := os.WriteFile(filePath, []byte("a\nb\nc\nD-patched\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	diff := gitIn(t, repoDir, "diff")
	gitIn(t, repoDir, "checkout", "--", "file.txt")

	// Repo moves on: line 2 changes and is committed (tree stays clean). Line 2
	// sits inside the patch hunk's context, so a strict apply can no longer match.
	if err := os.WriteFile(filePath, []byte("a\nB-moved\nc\nd\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "commit", "-am", "advance")

	createdAt := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	state := patchApplyState(repoDir, domain.PatchStatusApproved, createdAt)
	state.PatchProposals[0].Diff = diff
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.ApplyPatch("patch_1"); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}

	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	// Both the repo's later change (line 2) and the patch (line 4) survive.
	if string(content) != "a\nB-moved\nc\nD-patched\ne\nf\ng\n" {
		t.Fatalf("merged content = %q, want %q", string(content), "a\nB-moved\nc\nD-patched\ne\nf\ng\n")
	}
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}
