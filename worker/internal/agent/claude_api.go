package agent

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func callClaude(ctx context.Context, system, userMessage string) (string, error) {
	prompt := fmt.Sprintf("<system>\n%s\n</system>\n\n%s", system, userMessage)
	cmd := exec.CommandContext(ctx, "claude", "--print")
	cmd.Stdin = strings.NewReader(prompt)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("claude CLI: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", fmt.Errorf("claude CLI: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func claudeCLIAvailable() bool {
	_, err := exec.LookPath("claude")
	return err == nil
}

var repoSourceExtensions = []string{
	".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs",
	".java", ".cs", ".rb", ".swift", ".c", ".cpp", ".h",
}

var repoMetaFiles = []string{
	"package.json", "go.mod", "Cargo.toml", "pyproject.toml",
	"tsconfig.json", "README.md",
}

func readRepoContext(repoPath string) (context string, files []string, err error) {
	const maxBytes = 60_000

	var sb strings.Builder

	for _, meta := range repoMetaFiles {
		p := filepath.Join(repoPath, meta)
		content, readErr := os.ReadFile(p)
		if readErr != nil {
			continue
		}
		rel, _ := filepath.Rel(repoPath, p)
		chunk := fmt.Sprintf("=== %s ===\n%s\n\n", rel, content)
		if sb.Len()+len(chunk) > maxBytes {
			break
		}
		sb.WriteString(chunk)
		files = append(files, rel)
	}

	err = filepath.Walk(repoPath, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if info.IsDir() {
			switch info.Name() {
			case "node_modules", ".git", ".orbital", "dist", "build", "target", "vendor", "__pycache__":
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		for _, allowed := range repoSourceExtensions {
			if ext == allowed {
				content, readErr := os.ReadFile(path)
				if readErr != nil {
					return nil
				}
				rel, _ := filepath.Rel(repoPath, path)
				chunk := fmt.Sprintf("=== %s ===\n%s\n\n", rel, content)
				if sb.Len()+len(chunk) > maxBytes {
					return filepath.SkipDir
				}
				sb.WriteString(chunk)
				files = append(files, rel)
				break
			}
		}
		return nil
	})

	context = sb.String()
	return context, files, err
}

func extractJSONArray(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		if nl := strings.Index(s, "\n"); nl != -1 {
			s = s[nl+1:]
		}
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
	}
	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start != -1 && end > start {
		return s[start : end+1]
	}
	return s
}
