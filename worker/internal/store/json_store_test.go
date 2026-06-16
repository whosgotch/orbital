package store

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func TestJSONStoreLoadMissingFileReturnsEmptyState(t *testing.T) {
	store := NewJSONStore(t.TempDir())

	state, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(state.Repositories) != 0 {
		t.Fatalf("expected no repositories, got %d", len(state.Repositories))
	}
}

func TestJSONStoreSaveAndLoad(t *testing.T) {
	store := NewJSONStore(t.TempDir())

	createdAt := time.Date(2026, 6, 8, 12, 0, 0, 0, time.UTC)
	want := &State{
		Repositories: []domain.Repository{
			{
				ID:        "repo_1",
				Path:      "/tmp/demo",
				Name:      "demo",
				Branch:    "main",
				CreatedAt: createdAt,
			},
		},
	}

	if err := store.Save(want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if len(got.Repositories) != 1 {
		t.Fatalf("expected 1 repository, got %d", len(got.Repositories))
	}

	if got.Repositories[0].ID != "repo_1" {
		t.Fatalf("repository ID = %q, want %q", got.Repositories[0].ID, "repo_1")
	}
}

func TestJSONStoreSavesEmptyCollectionsAsArrays(t *testing.T) {
	store := NewJSONStore(t.TempDir())

	if err := store.Save(&State{}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	data, err := os.ReadFile(store.StatePath())
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}

	if bytes.Contains(data, []byte("null")) {
		t.Fatalf("state JSON contains null collection: %s", data)
	}
}

func TestJSONStoreSaveDoesNotLeaveTempFiles(t *testing.T) {
	dir := t.TempDir()
	store := NewJSONStore(dir)

	if err := store.Save(&State{}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}

	for _, entry := range entries {
		if entry.Name() != stateFileName {
			t.Fatalf("unexpected state directory entry after save: %s", entry.Name())
		}
	}
}
