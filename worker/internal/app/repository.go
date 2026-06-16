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

	state, err := s.store.Load()
	if err != nil {
		return nil, err
	}

	for index, repository := range state.Repositories {
		if repository.Path == cleanPath {
			if repository.VerificationCommand == "" {
				state.Repositories[index].VerificationCommand = defaultVerificationCommand(cleanPath)
				if err := s.store.Save(state); err != nil {
					return nil, err
				}
			}

			return &state.Repositories[index], nil
		}
	}

	now := time.Now().UTC()
	repository := domain.Repository{
		ID:                  fmt.Sprintf("repo_%d", now.UnixNano()),
		Path:                cleanPath,
		Name:                filepath.Base(cleanPath),
		Branch:              "",
		VerificationCommand: defaultVerificationCommand(cleanPath),
		CreatedAt:           now,
	}

	state.Repositories = append(state.Repositories, repository)

	if err := s.store.Save(state); err != nil {
		return nil, err
	}

	return &repository, nil
}

func defaultVerificationCommand(repoPath string) string {
	if fileExists(filepath.Join(repoPath, "package.json")) {
		return "npm test"
	}
	if fileExists(filepath.Join(repoPath, "go.mod")) {
		return "go test ./..."
	}

	return "true"
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
