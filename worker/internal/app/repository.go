package app

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func (s *Service) OpenRepository(path string) (*domain.Repository, error) {
	cleanPath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(cleanPath)
	if err != nil {
		return nil, err
	}

	if !info.IsDir() {
		return nil, fmt.Errorf("repository path is not a directory: %s", cleanPath)
	}

	now := time.Now().UTC()
	repository := domain.Repository{
		ID:        fmt.Sprintf("repo_%d", now.UnixNano()),
		Path:      cleanPath,
		Name:      filepath.Base(cleanPath),
		Branch:    "",
		CreatedAt: now,
	}

	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	state.Repositories = append(state.Repositories, repository)

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	return &repository, nil
}
