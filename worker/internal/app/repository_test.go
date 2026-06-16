package app

import (
	"os"
	"path/filepath"
	"testing"

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

	if repository.VerificationCommand != "true" {
		t.Fatalf("verification command = %q, want %q", repository.VerificationCommand, "true")
	}

	state, err := store.NewJSONStore(stateDir).Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(state.Repositories) != 1 {
		t.Fatalf("expected 1 repository, got %d", len(state.Repositories))
	}
}

func TestOpenRepositorySetsNodeVerificationCommand(t *testing.T) {
	repoDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(repoDir, "package.json"), []byte(`{"scripts":{"test":"vitest run"}}`), 0644); err != nil {
		t.Fatalf("WriteFile(package.json) error = %v", err)
	}

	svc := NewService(store.NewJSONStore(t.TempDir()))

	repository, err := svc.OpenRepository(repoDir)
	if err != nil {
		t.Fatalf("OpenRepository() error = %v", err)
	}

	if repository.VerificationCommand != "npm test" {
		t.Fatalf("verification command = %q, want %q", repository.VerificationCommand, "npm test")
	}
}

func TestOpenRepositorySetsGoVerificationCommand(t *testing.T) {
	repoDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(repoDir, "go.mod"), []byte("module example.com/demo\n"), 0644); err != nil {
		t.Fatalf("WriteFile(go.mod) error = %v", err)
	}

	svc := NewService(store.NewJSONStore(t.TempDir()))

	repository, err := svc.OpenRepository(repoDir)
	if err != nil {
		t.Fatalf("OpenRepository() error = %v", err)
	}

	if repository.VerificationCommand != "go test ./..." {
		t.Fatalf("verification command = %q, want %q", repository.VerificationCommand, "go test ./...")
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
