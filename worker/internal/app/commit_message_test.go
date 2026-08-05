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

// The gate's message box is the commit message: what the user typed lands
// verbatim, body and all, instead of the engineer's suggested subject.
func TestApplyPatchCommitsTheEditedMessage(t *testing.T) {
	svc, repoDir := repoWithApprovedPatch(t)

	message := "feat(gate): commit what the user typed\n\nThe body survives too."
	patch, err := svc.ApplyPatch("patch_1", message)
	if err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}

	if patch.CommitSubject != "feat(gate): commit what the user typed" {
		t.Fatalf("CommitSubject = %q, want the message's first line", patch.CommitSubject)
	}
	if body := strings.TrimSpace(gitIn(t, repoDir, "log", "-1", "--pretty=%B")); body != message {
		t.Fatalf("commit message = %q, want %q", body, message)
	}
}

func TestAmendCommitRewritesTheMessage(t *testing.T) {
	svc, repoDir := repoWithApprovedPatch(t)

	applied, err := svc.ApplyPatch("patch_1", "feat(gate): first try")
	if err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}

	amended, err := svc.AmendCommit("patch_1", "feat(gate): second thoughts")
	if err != nil {
		t.Fatalf("AmendCommit() error = %v", err)
	}

	if amended.CommitSubject != "feat(gate): second thoughts" {
		t.Fatalf("CommitSubject = %q, want the amended subject", amended.CommitSubject)
	}
	if amended.CommitHash == applied.CommitHash || amended.CommitHash == "" {
		t.Fatalf("CommitHash = %q, want the rewritten commit's hash (was %q)", amended.CommitHash, applied.CommitHash)
	}
	if subject := strings.TrimSpace(gitIn(t, repoDir, "log", "-1", "--pretty=%s")); subject != "feat(gate): second thoughts" {
		t.Fatalf("git log subject = %q, want the amended subject", subject)
	}
	// One commit was rewritten, not added: base + the mission's own commit.
	if count := strings.TrimSpace(gitIn(t, repoDir, "rev-list", "--count", "HEAD")); count != "2" {
		t.Fatalf("commit count = %q, want 2", count)
	}
}

// Amending once another commit sits on top would rewrite someone else's commit,
// so the gate refuses instead and says why.
func TestAmendCommitRefusesWhenTheCommitIsNoLongerHead(t *testing.T) {
	svc, repoDir := repoWithApprovedPatch(t)

	if _, err := svc.ApplyPatch("patch_1", "feat(gate): landed"); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "other.txt"), []byte("later\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "someone else's work")

	if _, err := svc.AmendCommit("patch_1", "feat(gate): too late"); err == nil {
		t.Fatal("AmendCommit() succeeded, want a refusal once the commit is not HEAD")
	}
	if subject := strings.TrimSpace(gitIn(t, repoDir, "log", "-1", "--pretty=%s")); subject != "someone else's work" {
		t.Fatalf("git log subject = %q, want the later commit untouched", subject)
	}
}

// Rewording a pushed commit diverges the branch from the remote, so the gate
// refuses once it has left the machine.
func TestAmendCommitRefusesOnceTheCommitIsPushed(t *testing.T) {
	svc, repoDir := repoWithApprovedPatch(t)
	remoteDir := t.TempDir()
	gitIn(t, remoteDir, "init", "--bare")
	gitIn(t, repoDir, "remote", "add", "origin", remoteDir)

	if _, err := svc.ApplyPatch("patch_1", "feat(gate): landed"); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
	// Amending is fine while the commit is still only local.
	if _, err := svc.AmendCommit("patch_1", "feat(gate): reworded before push"); err != nil {
		t.Fatalf("AmendCommit() before push error = %v", err)
	}
	if _, err := PushRepo(repoDir); err != nil {
		t.Fatalf("PushRepo() error = %v", err)
	}

	if _, err := svc.AmendCommit("patch_1", "feat(gate): too late"); err == nil {
		t.Fatal("AmendCommit() succeeded on a pushed commit, want a refusal")
	}
	if subject := strings.TrimSpace(gitIn(t, repoDir, "log", "-1", "--pretty=%s")); subject != "feat(gate): reworded before push" {
		t.Fatalf("git log subject = %q, want the pushed commit untouched", subject)
	}
	// Refusing means refusing outright: the branch must not be left diverged.
	if sync := GitSyncState(repoDir); sync.Ahead != 0 || sync.Behind != 0 {
		t.Fatalf("GitSyncState() = %+v, want the branch still level with its upstream", sync)
	}
}

func TestGitSyncStateReportsNoRemoteWhenThereIsNone(t *testing.T) {
	_, repoDir := repoWithApprovedPatch(t)

	sync := GitSyncState(repoDir)
	if sync.Remote != "" || sync.Upstream != "" {
		t.Fatalf("GitSyncState() = %+v, want no remote and no upstream", sync)
	}
	if sync.Branch == "" {
		t.Fatalf("GitSyncState() branch = %q, want the current branch", sync.Branch)
	}
	if _, err := PushRepo(repoDir); err == nil {
		t.Fatal("PushRepo() succeeded with no remote, want an error")
	}
}

// First push publishes the branch (-u), so afterwards it has an upstream and
// nothing is ahead of it.
func TestPushRepoPublishesAnUnpushedBranch(t *testing.T) {
	_, repoDir := repoWithApprovedPatch(t)
	remoteDir := t.TempDir()
	gitIn(t, remoteDir, "init", "--bare")
	gitIn(t, repoDir, "remote", "add", "origin", remoteDir)

	before := GitSyncState(repoDir)
	if before.Remote != "origin" || before.Upstream != "" || before.Ahead == 0 {
		t.Fatalf("GitSyncState() before push = %+v, want origin, no upstream, commits ahead", before)
	}

	after, err := PushRepo(repoDir)
	if err != nil {
		t.Fatalf("PushRepo() error = %v", err)
	}
	if after.Upstream == "" || after.Ahead != 0 || after.Behind != 0 {
		t.Fatalf("GitSyncState() after push = %+v, want an upstream and nothing ahead", after)
	}
}

// A git repo holding one committed file plus an approved patch that rewrites it.
func repoWithApprovedPatch(t *testing.T) (*Service, string) {
	t.Helper()

	svc := NewService(store.NewJSONStore(t.TempDir()))
	repoDir := t.TempDir()

	gitIn(t, repoDir, "init")
	gitIn(t, repoDir, "config", "user.email", "t@t")
	gitIn(t, repoDir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(repoDir, "file.txt"), []byte("before\n"), 0644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repoDir, "add", "-A")
	gitIn(t, repoDir, "commit", "-m", "base")

	createdAt := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	state := patchApplyState(repoDir, domain.PatchStatusApproved, createdAt)
	if err := svc.store.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	return svc, repoDir
}
