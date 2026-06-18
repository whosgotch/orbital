package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const claudeAPIURL = "https://api.anthropic.com/v1/messages"
const claudeAPIVersion = "2023-06-01"
const claudeDefaultModel = "claude-opus-4-8"

type claudeMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type claudeRequest struct {
	Model     string          `json:"model"`
	MaxTokens int             `json:"max_tokens"`
	System    string          `json:"system,omitempty"`
	Messages  []claudeMessage `json:"messages"`
}

type claudeContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type claudeResponse struct {
	Content []claudeContent `json:"content"`
	Error   *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func callClaude(apiKey, system, userMessage string, maxTokens int) (string, error) {
	body, err := json.Marshal(claudeRequest{
		Model:     claudeDefaultModel,
		MaxTokens: maxTokens,
		System:    system,
		Messages:  []claudeMessage{{Role: "user", Content: userMessage}},
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest("POST", claudeAPIURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", claudeAPIVersion)
	req.Header.Set("content-type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("claude request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	var claudeResp claudeResponse
	if err := json.Unmarshal(respBody, &claudeResp); err != nil {
		return "", fmt.Errorf("claude response parse failed: %w", err)
	}

	if claudeResp.Error != nil {
		return "", fmt.Errorf("claude API error: %s", claudeResp.Error.Message)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("claude API returned %d: %s", resp.StatusCode, respBody)
	}

	if len(claudeResp.Content) == 0 {
		return "", fmt.Errorf("claude returned empty response")
	}

	return claudeResp.Content[0].Text, nil
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

	// Meta files first
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

	// Source files via walk
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
	// Strip markdown fences
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		if nl := strings.Index(s, "\n"); nl != -1 {
			s = s[nl+1:]
		}
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
	}
	// Extract first [...] block
	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start != -1 && end > start {
		return s[start : end+1]
	}
	return s
}
