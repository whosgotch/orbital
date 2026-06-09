package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func createDemoFixture(args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return usageError()
	}

	repoPath := args[2]
	srcDir := filepath.Join(repoPath, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(repoPath, "package.json"), []byte(demoPackageJSON), 0644); err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(srcDir, "cli.ts"), []byte(demoCLI), 0644); err != nil {
		return err
	}

	if err := os.RemoveAll(filepath.Join(repoPath, ".orbital")); err != nil {
		return err
	}

	fmt.Fprintf(stdout, "demo fixture ready: %s\n", repoPath)
	return nil
}

const demoPackageJSON = `{
  "name": "demo",
  "type": "module",
  "bin": {
    "demo": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  }
}
`

const demoCLI = `import pkg from "../package.json";

const command = process.argv[2];

console.log("Usage: demo <command>");
`
