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

// Two missions build their patches against the same base; landing the first
// used to leave the repo's working tree ahead of its index, so the second
// apply died with "does not match index". Committing each applied patch keeps
// the repo consistent, and both missions end up as their own commits.
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

	if _, err := svc.ApplyPatch("patch_1"); err != nil {
		t.Fatalf("ApplyPatch(patch_1) error = %v", err)
	}
	if _, err := svc.ApplyPatch("patch_2"); err != nil {
		t.Fatalf("ApplyPatch(patch_2) error = %v", err)
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
