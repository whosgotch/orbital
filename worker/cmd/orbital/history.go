package main

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/whosgotch/orbital/worker/internal/app"
)

// showHistory prints a repo's recent commits: `history <repo>` as lines for
// humans, `history --json <repo>` as JSON for the app's history viewer.
func showHistory(args []string, stdout io.Writer) error {
	if len(args) == 4 && args[2] == "--json" {
		commits, err := app.RepoHistory(args[3], 50)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(commits)
	}
	if len(args) != 3 {
		return usageError()
	}

	commits, err := app.RepoHistory(args[2], 50)
	if err != nil {
		return err
	}
	for _, commit := range commits {
		_, _ = fmt.Fprintf(stdout, "%s  %s  %s\n", commit.ShortHash, commit.Date, commit.Subject)
	}
	return nil
}

// showCommit prints one commit's unified diff, for the app's diff renderer.
func showCommit(args []string, stdout io.Writer) error {
	if len(args) != 4 {
		return usageError()
	}

	diff, err := app.CommitDiff(args[2], args[3])
	if err != nil {
		return err
	}
	_, err = io.WriteString(stdout, diff)
	return err
}
