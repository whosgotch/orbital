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

// A repo can carry leftover uncommitted edits. git apply --3way refuses to
// touch such a file ("does not match index"), so ApplyPatch must fold the
// leftovers in and still land the new patch.
func TestApplyPatchLandsOnDirtyWorkingTree(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()
	filePath := filepath.Join(repoDir, "file.txt")

	gitIn(t, repoDir, "init")
	gitIn(t, repoDir, "config", "user.email", "t@t")
	gitIn(t, repoDir, "config", "user.name", "t")

	// Base the mission's patch is built against.
	if err := os.WriteFile(filePath, []byte("a\nb\nc\nd\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "base")

	// The mission's patch edits line 4.
	if err := os.WriteFile(filePath, []byte("a\nb\nc\nD-mission\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}
	diff := gitIn(t, repoDir, "diff")
	gitIn(t, repoDir, "checkout", "--", "file.txt")

	// Leftover uncommitted edit on line 2: working tree no longer matches the
	// index — the state the 3-way merge must survive.
	if err := os.WriteFile(filePath, []byte("a\nB-leftover\nc\nd\ne\nf\ng\n"), 0644); err != nil {
		t.Fatal(err)
	}

	createdAt := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	state := patchApplyState(repoDir, domain.PatchStatusApproved, createdAt)
	state.PatchProposals[0].Diff = diff
	state.Missions[0].Text = "edit line four"
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.ApplyPatch("patch_1", ""); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}

	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "a\nB-leftover\nc\nD-mission\ne\nf\ng\n" {
		t.Fatalf("content = %q, want leftover + mission edits", string(content))
	}

	// The mission landed as a commit and took the leftover along — clean tree.
	if status := strings.TrimSpace(gitIn(t, repoDir, "status", "--porcelain")); status != "" {
		t.Fatalf("working tree not clean after apply: %q", status)
	}
	log := gitIn(t, repoDir, "log", "--pretty=%s")
	if lines := strings.Split(strings.TrimSpace(log), "\n"); len(lines) != 2 || lines[0] != "edit line four" {
		t.Fatalf("git log = %q, want the mission commit on top of base", log)
	}
}
