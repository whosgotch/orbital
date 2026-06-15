package main

import (
	"io"
	"path/filepath"

	"github.com/whosgotch/orbital/worker/internal/app"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func openRepository(args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return usageError()
	}

	repoPath := args[2]
	jsonStore := store.NewJSONStore(filepath.Join(repoPath, ".orbital"))
	service := app.NewService(jsonStore)

	if _, err := service.OpenRepository(repoPath); err != nil {
		return err
	}

	return showStatusJSON(repoPath, stdout)
}
