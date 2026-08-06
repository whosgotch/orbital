package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func branchRepo(t *testing.T) string {
	t.Helper()

	repoDir := t.TempDir()
	gitIn(t, repoDir, "init")
	gitIn(t, repoDir, "config", "user.email", "t@t")
	gitIn(t, repoDir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(repoDir, "file.txt"), []byte("before\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "base")
	return repoDir
}

func TestSwitchBranchCreatesThenReturnsToAnExistingBranch(t *testing.T) {
	repoDir := branchRepo(t)
	base := GitSyncState(repoDir).Branch

	sync, err := SwitchBranch(repoDir, "feature/picker", true)
	if err != nil {
		t.Fatalf("SwitchBranch() create error = %v", err)
	}
	if sync.Branch != "feature/picker" {
		t.Fatalf("SwitchBranch() branch = %q, want the new branch checked out", sync.Branch)
	}

	sync, err = SwitchBranch(repoDir, base, false)
	if err != nil {
		t.Fatalf("SwitchBranch() error = %v", err)
	}
	if sync.Branch != base {
		t.Fatalf("SwitchBranch() branch = %q, want %q", sync.Branch, base)
	}

	branches := ListBranches(repoDir)
	if len(branches) != 2 || branches[0] != "feature/picker" {
		t.Fatalf("ListBranches() = %v, want both branches with the latest commit first", branches)
	}
}

// A name that also names a file must never be read as a pathspec: `git checkout`
// would discard that file's edits instead of switching.
func TestSwitchBranchDoesNotDiscardAFileSharingTheBranchName(t *testing.T) {
	repoDir := branchRepo(t)
	if err := os.WriteFile(filepath.Join(repoDir, "file.txt"), []byte("uncommitted\n"), 0644); err != nil {
		t.Fatal(err)
	}

	if _, err := SwitchBranch(repoDir, "file.txt", false); err == nil {
		t.Fatal("SwitchBranch() to a non-branch succeeded, want a refusal")
	}

	content, err := os.ReadFile(filepath.Join(repoDir, "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "uncommitted\n" {
		t.Fatalf("file.txt = %q, want the uncommitted edit untouched", content)
	}
}

func TestSwitchBranchReportsGitsRefusalWhenTheBranchIsMissing(t *testing.T) {
	repoDir := branchRepo(t)

	_, err := SwitchBranch(repoDir, "never-created", false)
	if err == nil {
		t.Fatal("SwitchBranch() to a missing branch succeeded, want a refusal")
	}
	if !strings.Contains(err.Error(), "never-created") {
		t.Fatalf("SwitchBranch() error = %v, want git's own words naming the branch", err)
	}
}

func TestListBranchesIsEmptyOutsideAGitRepo(t *testing.T) {
	if branches := ListBranches(t.TempDir()); len(branches) != 0 {
		t.Fatalf("ListBranches() = %v, want none outside a repository", branches)
	}
}
