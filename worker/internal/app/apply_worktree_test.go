package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestChangedFilesParsesModifyAddDelete(t *testing.T) {
	diff := "diff --git a/keep.go b/keep.go\n" +
		"--- a/keep.go\n+++ b/keep.go\n@@ -1 +1 @@\n-old\n+new\n" +
		"diff --git a/new.go b/new.go\nnew file mode 100644\n--- /dev/null\n+++ b/new.go\n@@ -0,0 +1 @@\n+hi\n" +
		"diff --git a/gone.go b/gone.go\ndeleted file mode 100644\n--- a/gone.go\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"

	got := changedFiles(diff)
	if len(got) != 3 {
		t.Fatalf("changedFiles = %d entries, want 3: %+v", len(got), got)
	}
	want := map[string]bool{"keep.go": false, "new.go": false, "gone.go": true}
	for _, change := range got {
		deleted, ok := want[change.path]
		if !ok {
			t.Errorf("unexpected path %q", change.path)
			continue
		}
		if deleted != change.deleted {
			t.Errorf("%q deleted = %v, want %v", change.path, change.deleted, deleted)
		}
	}
}

func TestApplyFromWorktreeSyncsFiles(t *testing.T) {
	repo := t.TempDir()
	worktree := t.TempDir()

	// Repo starts with an old version of keep.go and a file that will be deleted.
	if err := os.WriteFile(filepath.Join(repo, "keep.go"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "gone.go"), []byte("bye\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The worktree holds the desired end state: updated keep.go, a new file.
	if err := os.WriteFile(filepath.Join(worktree, "keep.go"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "new.go"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	diff := "--- a/keep.go\n+++ b/keep.go\n" +
		"--- /dev/null\n+++ b/new.go\n" +
		"--- a/gone.go\n+++ /dev/null\n"

	if err := applyFromWorktree(repo, worktree, diff); err != nil {
		t.Fatalf("applyFromWorktree() error = %v", err)
	}

	if got, _ := os.ReadFile(filepath.Join(repo, "keep.go")); string(got) != "new\n" {
		t.Errorf("keep.go = %q, want updated content", got)
	}
	if got, _ := os.ReadFile(filepath.Join(repo, "new.go")); string(got) != "hi\n" {
		t.Errorf("new.go = %q, want copied content", got)
	}
	if _, err := os.Stat(filepath.Join(repo, "gone.go")); !os.IsNotExist(err) {
		t.Errorf("gone.go should have been deleted")
	}
}
