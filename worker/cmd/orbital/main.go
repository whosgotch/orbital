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
	case "approve":
		return approveMissionPatch(args, stdout)
	case "open":
		return openRepository(args, stdout)
	case "queue":
		return queueMission(args, stdout)
	case "delete":
		return deleteMission(args, stdout)
	case "edit-mission":
		return editMission(args, stdout)
	case "link":
		return linkMissions(args, stdout)
	case "plan":
		return planRepo(ctx, args, stdout)
	case "unlink":
		return unlinkMissions(args, stdout)
	case "reject":
		return rejectMissionPatch(args, stdout)
	case "start-run":
		return startAgentRun(ctx, args, stdout)
	case "send-message":
		return sendAgentMessage(ctx, args, stdout)
	case "verify":
		return verifyMission(ctx, args, stdout)
	case "run":
		return runMission(ctx, args, stdout)
	case "status":
		return showStatus(args, stdout)
	case "history":
		return showHistory(args, stdout)
	case "show":
		return showCommit(args, stdout)
	case "models":
		return listModels(args, stdout)
	case "demo-fixture":
		return createDemoFixture(args, stdout)
	default:
		return usageError()
	}
}

func usageError() error {
	return fmt.Errorf("usage: orbital open <repo-path>\n       orbital queue <repo-path> <mission-text> [--campaign <id>] [--tool <command>]\n       orbital edit-mission <repo-path> <mission-id> <text>\n       orbital link <repo-path> <from-mission-id> <to-mission-id>\n       orbital unlink <repo-path> <from-mission-id> <to-mission-id>\n       orbital plan <repo-path> [goal] [--format md|html|text] [--model <id>]\n       orbital start-run <repo-path> <mission-id>\n       orbital send-message <repo-path> <mission-id> <text>\n       orbital approve <repo-path> <mission-id>\n       orbital reject <repo-path> <mission-id>\n       orbital verify <repo-path> <mission-id> <verification-command>\n       orbital run <repo-path> <mission-text> <verification-command>\n       orbital status <repo-path>\n       orbital status --json <repo-path>\n       orbital history <repo-path>\n       orbital history --json <repo-path>\n       orbital show <repo-path> <commit-hash>\n       orbital demo-fixture <repo-path>")
}
