package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func TestOpenRepositorySavesRepository(t *testing.T) {
	repoDir := t.TempDir()
	stateDir := t.TempDir()

	svc := NewService(store.NewJSONStore(stateDir))

	repository, err := svc.OpenRepository(repoDir)
	if err != nil {
		t.Fatalf("OpenRepository() error = %v", err)
	}

	if repository.Path != repoDir {
		t.Fatalf("repository path = %q, want %q", repository.Path, repoDir)
	}

	if repository.Name != filepath.Base(repoDir) {
		t.Fatalf("repository name = %q, want %q", repository.Name, filepath.Base(repoDir))
	}

	state, err := store.NewJSONStore(stateDir).Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(state.Repositories) != 1 {
		t.Fatalf("expected 1 repository, got %d", len(state.Repositories))
	}
}

func TestOpenRepositorySetsGitBranch(t *testing.T) {
	repoDir := initGitRepository(t)
	svc := NewService(store.NewJSONStore(t.TempDir()))

	repository, err := svc.OpenRepository(repoDir)
	if err != nil {
		t.Fatalf("OpenRepository() error = %v", err)
	}

	if repository.Branch != "main" {
		t.Fatalf("repository branch = %q, want %q", repository.Branch, "main")
	}
}

func TestOpenRepositoryReturnsExistingRepositoryForSamePath(t *testing.T) {
	repoDir := t.TempDir()
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)

	first, err := svc.OpenRepository(repoDir)
	if err != nil {
		t.Fatalf("OpenRepository() first error = %v", err)
	}

	second, err := svc.OpenRepository(repoDir)
	if err != nil {
		t.Fatalf("OpenRepository() second error = %v", err)
	}

	if second.ID != first.ID {
		t.Fatalf("second repository ID = %q, want %q", second.ID, first.ID)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(state.Repositories) != 1 {
		t.Fatalf("expected 1 repository, got %d", len(state.Repositories))
	}
}

func TestOpenRepositoryBackfillsMissingBranch(t *testing.T) {
	repoDir := initGitRepository(t)
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{
			{
				ID:   "repo_1",
				Path: repoDir,
				Name: "demo",
			},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	svc := NewService(jsonStore)

	repository, err := svc.OpenRepository(repoDir)
	if err != nil {
		t.Fatalf("OpenRepository() error = %v", err)
	}

	if repository.Branch != "main" {
		t.Fatalf("repository branch = %q, want %q", repository.Branch, "main")
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if state.Repositories[0].Branch != "main" {
		t.Fatalf("saved repository branch = %q, want %q", state.Repositories[0].Branch, "main")
	}
}

func TestOpenRepositoryRejectsFilePath(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "not-a-repo.txt")

	if err := os.WriteFile(filePath, []byte("test"), 0644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	svc := NewService(store.NewJSONStore(t.TempDir()))

	if _, err := svc.OpenRepository(filePath); err == nil {
		t.Fatal("expected error for file path, got nil")
	}
}

func initGitRepository(t *testing.T) string {
	t.Helper()

	repoDir := t.TempDir()
	runGit(t, repoDir, "init", "-b", "main")
	// CI runners have no global git identity, so commits need a local one.
	runGit(t, repoDir, "config", "user.email", "t@t")
	runGit(t, repoDir, "config", "user.name", "t")
	return repoDir
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v error = %v, output = %s", args, err, string(output))
	}
}
