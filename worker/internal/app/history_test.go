package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepoHistoryListsCommitsNewestFirst(t *testing.T) {
	repoDir := t.TempDir()
	gitIn(t, repoDir, "init")
	gitIn(t, repoDir, "config", "user.email", "t@t")
	gitIn(t, repoDir, "config", "user.name", "tester")

	filePath := filepath.Join(repoDir, "file.txt")
	if err := os.WriteFile(filePath, []byte("one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "first commit")
	if err := os.WriteFile(filePath, []byte("two\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "commit", "-am", "second commit")

	commits, err := RepoHistory(repoDir, 10)
	if err != nil {
		t.Fatalf("RepoHistory() error = %v", err)
	}
	if len(commits) != 2 {
		t.Fatalf("len(commits) = %d, want 2", len(commits))
	}
	if commits[0].Subject != "second commit" || commits[1].Subject != "first commit" {
		t.Fatalf("subjects = %q, %q; want newest first", commits[0].Subject, commits[1].Subject)
	}
	if commits[0].Author != "tester" || commits[0].ShortHash == "" || commits[0].Date == "" {
		t.Fatalf("commit fields incomplete: %+v", commits[0])
	}

	diff, err := CommitDiff(repoDir, commits[0].Hash)
	if err != nil {
		t.Fatalf("CommitDiff() error = %v", err)
	}
	if !strings.Contains(diff, "-one") || !strings.Contains(diff, "+two") {
		t.Fatalf("diff = %q, want the second commit's change", diff)
	}
}

func TestRepoHistoryIsEmptyForNonGitDir(t *testing.T) {
	commits, err := RepoHistory(t.TempDir(), 10)
	if err != nil {
		t.Fatalf("RepoHistory() error = %v", err)
	}
	if len(commits) != 0 {
		t.Fatalf("len(commits) = %d, want 0", len(commits))
	}
}

func TestCommitDiffRejectsInvalidHash(t *testing.T) {
	if _, err := CommitDiff(t.TempDir(), "HEAD; rm -rf /"); err == nil {
		t.Fatal("expected error for invalid hash")
	}
}
