package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateDemoFixtureResetsFilesAndState(t *testing.T) {
	repoDir := t.TempDir()
	stateDir := filepath.Join(repoDir, ".orbital")
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		t.Fatalf("MkdirAll(.orbital) error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(stateDir, "state.json"), []byte("{}"), 0644); err != nil {
		t.Fatalf("WriteFile(state.json) error = %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "package.json"), []byte(`{"version":"0.1.0"}`), 0644); err != nil {
		t.Fatalf("WriteFile(package.json) error = %v", err)
	}

	var output bytes.Buffer
	err := run(context.Background(), []string{"orbital", "demo-fixture", repoDir}, &output)
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}

	packageJSON, err := os.ReadFile(filepath.Join(repoDir, "package.json"))
	if err != nil {
		t.Fatalf("ReadFile(package.json) error = %v", err)
	}

	if string(packageJSON) != demoPackageJSON {
		t.Fatalf("package.json = %q, want fixture content", string(packageJSON))
	}

	cli, err := os.ReadFile(filepath.Join(repoDir, "src", "cli.ts"))
	if err != nil {
		t.Fatalf("ReadFile(cli.ts) error = %v", err)
	}

	if string(cli) != demoCLI {
		t.Fatalf("cli.ts = %q, want fixture content", string(cli))
	}

	if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
		t.Fatalf("expected .orbital to be removed, stat error = %v", err)
	}

	if output.String() == "" {
		t.Fatal("expected fixture command output")
	}
}

func TestRunRejectsUnknownCommand(t *testing.T) {
	if err := run(context.Background(), []string{"orbital", "unknown"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected usage error, got nil")
	}
}
