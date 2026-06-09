package main

import (
	"context"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(context.Background(), os.Args, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) < 2 {
		return usageError()
	}

	switch args[1] {
	case "run":
		return runMission(ctx, args, stdout)
	case "status":
		return showStatus(args, stdout)
	case "demo-fixture":
		return createDemoFixture(args, stdout)
	default:
		return usageError()
	}
}

func usageError() error {
	return fmt.Errorf("usage: orbital run <repo-path> <mission-text> <verification-command>\n       orbital status <repo-path>\n       orbital demo-fixture <repo-path>")
}
