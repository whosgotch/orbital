package app

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// Commit is one entry of a repository's git history, shaped for the app's
// history viewer. It is read straight from git, never stored.
type Commit struct {
	Hash      string `json:"hash"`
	ShortHash string `json:"short_hash"`
	Author    string `json:"author"`
	Date      string `json:"date"`
	Subject   string `json:"subject"`
}

// RepoHistory lists the repository's most recent commits, newest first.
// Returns an empty list for a repo without commits (or a non-git dir), since
// "no history yet" is a normal state for the viewer, not an error.
func RepoHistory(repoPath string, limit int) ([]Commit, error) {
	if limit <= 0 {
		limit = 50
	}

	// Unit/record separators keep parsing safe against any subject content.
	cmd := exec.Command("git", "log", "-n", strconv.Itoa(limit),
		"--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e")
	cmd.Dir = repoPath
	output, err := cmd.Output()
	if err != nil {
		return []Commit{}, nil
	}

	commits := []Commit{}
	for _, record := range strings.Split(string(output), "\x1e") {
		record = strings.TrimSpace(record)
		if record == "" {
			continue
		}
		fields := strings.Split(record, "\x1f")
		if len(fields) != 5 {
			continue
		}
		commits = append(commits, Commit{
			Hash:      fields[0],
			ShortHash: fields[1],
			Author:    fields[2],
			Date:      fields[3],
			Subject:   fields[4],
		})
	}
	return commits, nil
}

var commitHashPattern = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// CommitDiff returns one commit's changes as a unified diff, ready for the
// same renderer that shows patch proposals.
func CommitDiff(repoPath, hash string) (string, error) {
	if !commitHashPattern.MatchString(hash) {
		return "", fmt.Errorf("invalid commit hash: %s", hash)
	}

	cmd := exec.Command("git", "show", "--format=", "--patch", hash)
	cmd.Dir = repoPath
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("show commit %s: %w: %s", hash, err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}
