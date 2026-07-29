package app

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
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

	var result domain.Repository
	_, err = s.store.Update(func(state *store.State) error {
		for index, repository := range state.Repositories {
			if repository.Path == cleanPath {
				if repository.Branch == "" {
					state.Repositories[index].Branch = currentGitBranch(cleanPath)
				}
				result = state.Repositories[index]
				return nil
			}
		}

		now := time.Now().UTC()
		repository := domain.Repository{
			ID:        fmt.Sprintf("repo_%d", now.UnixNano()),
			Path:      cleanPath,
			Name:      filepath.Base(cleanPath),
			Branch:    currentGitBranch(cleanPath),
			CreatedAt: now,
		}

		state.Repositories = append(state.Repositories, repository)
		result = repository
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &result, nil
}

func currentGitBranch(repoPath string) string {
	cmd := exec.Command("git", "branch", "--show-current")
	cmd.Dir = repoPath

	output, err := cmd.Output()
	if err != nil {
		return ""
	}

	return strings.TrimSpace(string(output))
}
