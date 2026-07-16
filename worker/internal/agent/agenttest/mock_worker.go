// Package agenttest holds worker test doubles, compiled only into tests (via
// _test.go imports) and never into the shipped `orbital` binary.
package agenttest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/domain"
)

type MockWorker struct{}

const unsupportedMockRepoMessage = "Demo worker supports Node CLI repos with package.json and src/cli.ts."

func NewMockWorker() *MockWorker {
	return &MockWorker{}
}

func (w *MockWorker) Name() string {
	return "mock"
}

func (w *MockWorker) Profile() agent.WorkerProfile {
	return agent.WorkerProfile{
		Name: "mock",
		Mode: "demo",
		Roles: []string{
			"AI Manager",
			"Architect",
			"Engineer",
			"QA",
		},
		Capabilities: []string{
			"inspect repository metadata",
			"read demo Node CLI files",
			"propose a version command patch",
		},
		Limitations: []string{
			"only supports repositories with package.json and src/cli.ts",
			"does not perform real planning or general code generation",
		},
	}
}

func (w *MockWorker) CheckAvailable(ctx context.Context) (*agent.WorkerInfo, error) {
	return &agent.WorkerInfo{
		Name:      w.Name(),
		Available: true,
		Profile:   w.Profile(),
	}, nil
}

func (w *MockWorker) Supports(ctx context.Context, request agent.RunRequest) agent.SupportResult {
	if !fileExists(filepath.Join(request.RepoPath, "package.json")) || !fileExists(filepath.Join(request.RepoPath, "src", "cli.ts")) {
		return agent.SupportResult{
			Supported: false,
			Reason:    unsupportedMockRepoMessage,
		}
	}

	return agent.SupportResult{Supported: true}
}

func (w *MockWorker) StartRun(ctx context.Context, request agent.RunRequest) (<-chan agent.RunEvent, error) {
	events := make(chan agent.RunEvent)

	go func() {
		defer close(events)

		sendEvent := func(eventType domain.WorkflowEventType, message string, filePath string) bool {
			event := domain.WorkflowEvent{
				ID:        fmt.Sprintf("event_%d", time.Now().UTC().UnixNano()),
				RunID:     request.RunID,
				Type:      eventType,
				Message:   message,
				FilePath:  filePath,
				CreatedAt: time.Now().UTC(),
			}

			select {
			case <-ctx.Done():
				sendCancelledEvent(events, request.RunID)
				return false
			case events <- agent.RunEvent{WorkflowEvent: &event}:
				return true
			}
		}

		if !sendEvent(domain.WorkflowEventRunStarted, "Mock worker started.", "") {
			return
		}

		if !sendEvent(domain.WorkflowEventRepoInspected, "Repository inspected.", "") {
			return
		}

		if !sendEvent(domain.WorkflowEventFileRead, "Read package metadata.", "package.json") {
			return
		}

		if !sendEvent(domain.WorkflowEventFileRead, "Read CLI entrypoint.", "src/cli.ts") {
			return
		}

		diff, err := buildVersionCommandDiff(request.RepoPath)
		if err != nil {
			sendEvent(domain.WorkflowEventRunFailed, err.Error(), "")
			return
		}

		now := time.Now().UTC()
		patch := domain.PatchProposal{
			ID:        fmt.Sprintf("patch_%d", now.UnixNano()),
			RunID:     request.RunID,
			Status:    domain.PatchStatusPending,
			Diff:      diff,
			CreatedAt: now,
			UpdatedAt: now,
		}

		select {
		case <-ctx.Done():
			sendCancelledEvent(events, request.RunID)
			return
		case events <- agent.RunEvent{PatchProposal: &patch}:
		}

		if !sendEvent(domain.WorkflowEventPatchProposed, "Patch proposed.", "") {
			return
		}

		sendEvent(domain.WorkflowEventRunCompleted, "Mock worker completed.", "")
	}()

	return events, nil
}

func (w *MockWorker) CancelRun(ctx context.Context, runID string) error {
	return nil
}

func sendCancelledEvent(events chan<- agent.RunEvent, runID string) {
	events <- agent.RunEvent{
		WorkflowEvent: &domain.WorkflowEvent{
			ID:        fmt.Sprintf("event_%d", time.Now().UTC().UnixNano()),
			RunID:     runID,
			Type:      domain.WorkflowEventRunCancelled,
			Message:   "Run cancelled.",
			CreatedAt: time.Now().UTC(),
		},
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func buildVersionCommandDiff(repoPath string) (string, error) {
	packagePath := filepath.Join(repoPath, "package.json")
	cliPath := filepath.Join(repoPath, "src", "cli.ts")

	packageJSON, err := os.ReadFile(packagePath)
	if err != nil {
		return "", fmt.Errorf("read package.json: %w", err)
	}
	cli, err := os.ReadFile(cliPath)
	if err != nil {
		return "", fmt.Errorf("read src/cli.ts: %w", err)
	}

	nextPackageJSON, err := packageJSONWithVersion(packageJSON)
	if err != nil {
		return "", err
	}
	nextCLI := cliWithVersionCommand(cli)

	var diff strings.Builder
	if !bytes.Equal(packageJSON, nextPackageJSON) {
		fileDiff, err := fileDiff(repoPath, "package.json", nextPackageJSON)
		if err != nil {
			return "", err
		}
		diff.WriteString(fileDiff)
	}
	if !bytes.Equal(cli, nextCLI) {
		fileDiff, err := fileDiff(repoPath, filepath.Join("src", "cli.ts"), nextCLI)
		if err != nil {
			return "", err
		}
		diff.WriteString(fileDiff)
	}

	return diff.String(), nil
}

func packageJSONWithVersion(data []byte) ([]byte, error) {
	var packageJSON map[string]any
	if err := json.Unmarshal(data, &packageJSON); err != nil {
		return nil, fmt.Errorf("parse package.json: %w", err)
	}
	if _, ok := packageJSON["version"]; !ok {
		packageJSON["version"] = "0.1.0"
	}

	next, err := json.MarshalIndent(packageJSON, "", "  ")
	if err != nil {
		return nil, err
	}

	return append(next, '\n'), nil
}

func cliWithVersionCommand(data []byte) []byte {
	content := string(data)
	if strings.Contains(content, `command === "version"`) || strings.Contains(content, `command === "--version"`) {
		return data
	}

	versionBlock := `if (command === "version" || command === "--version") {
  console.log(pkg.version);
  process.exit(0);
}

`
	anchor := "const command = process.argv[2];\n\n"
	if strings.Contains(content, anchor) {
		return []byte(strings.Replace(content, anchor, anchor+versionBlock, 1))
	}

	return []byte(versionBlock + content)
}

func fileDiff(repoPath string, relativePath string, next []byte) (string, error) {
	tempDir, err := os.MkdirTemp("", "orbital-patch-*")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	tempPath := filepath.Join(tempDir, relativePath)
	if err := os.MkdirAll(filepath.Dir(tempPath), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(tempPath, next, 0644); err != nil {
		return "", err
	}

	cmd := exec.Command("git", "diff", "--no-index", "--", relativePath, tempPath)
	cmd.Dir = repoPath
	output, err := cmd.CombinedOutput()
	if err == nil {
		return "", nil
	}
	if exitError, ok := err.(*exec.ExitError); !ok || exitError.ExitCode() != 1 {
		return "", fmt.Errorf("generate diff for %s: %w: %s", relativePath, err, strings.TrimSpace(string(output)))
	}

	diff := string(output)
	tempDiffPath := strings.TrimPrefix(tempPath, string(filepath.Separator))
	diff = strings.ReplaceAll(diff, "b/"+tempDiffPath, "b/"+filepath.ToSlash(relativePath))
	diff = strings.ReplaceAll(diff, tempDiffPath, filepath.ToSlash(relativePath))

	return diff, nil
}
