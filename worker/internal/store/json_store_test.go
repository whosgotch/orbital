package store

import (
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
