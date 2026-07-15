package app

import (
	"context"
	"strings"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func chainedState(repoPath string) *store.State {
	return &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: repoPath, Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "m1", RepositoryID: "repo_1", Text: "add a parser", Status: domain.MissionStatusApproved},
			{ID: "m2", RepositoryID: "repo_1", Text: "use the parser in the CLI", Status: domain.MissionStatusDraft, DependsOn: []string{"m1"}},
		},
		AgentRuns: []domain.AgentRun{
			{ID: "run_1", MissionID: "m1", WorkerName: "claude-engineer", Status: domain.AgentRunStatusCompleted},
		},
		ChatMessages: []domain.ChatMessage{
			{ID: "c1", MissionID: "m1", RunID: "run_1", Role: domain.ChatRoleAssistant, Text: "Added parser.go with a Parse function."},
		},
		PatchProposals: []domain.PatchProposal{
			{ID: "p1", RunID: "run_1", Status: domain.PatchStatusApproved, Diff: "diff --git a/parser.go b/parser.go\n+func Parse() {}"},
		},
	}
}

func TestUpstreamContextComposesTextSummaryAndDiff(t *testing.T) {
	state := chainedState("/tmp/repo")

	contextBlock, titles := upstreamContextFor(state, state.Missions[1])

	if len(titles) != 1 || titles[0] != "add a parser" {
		t.Fatalf("titles = %v, want [add a parser]", titles)
	}
	for _, want := range []string{
		"## Upstream task: add a parser",
		"Outcome: Added parser.go with a Parse function.",
		"```diff",
		"+func Parse() {}",
	} {
		if !strings.Contains(contextBlock, want) {
			t.Fatalf("upstream context missing %q:\n%s", want, contextBlock)
		}
	}
}

func TestUpstreamContextEmptyWithoutDependencies(t *testing.T) {
	state := chainedState("/tmp/repo")

	contextBlock, titles := upstreamContextFor(state, state.Missions[0])

	if contextBlock != "" || titles != nil {
		t.Fatalf("expected empty context for mission without deps, got %q / %v", contextBlock, titles)
	}
}

func TestUpstreamContextTruncatesLongDiffs(t *testing.T) {
	state := chainedState("/tmp/repo")
	state.PatchProposals[0].Diff = strings.Repeat("x", upstreamDiffLimit+100)

	contextBlock, _ := upstreamContextFor(state, state.Missions[1])

	if !strings.Contains(contextBlock, "[truncated]") {
		t.Fatal("expected long diff to be truncated")
	}
	if len(contextBlock) > upstreamDiffLimit+1000 {
		t.Fatalf("context unexpectedly large: %d chars", len(contextBlock))
	}
}

// A task depending on a verified research mission gets the research
// document's findings in its context instead of a diff — research missions
// never land patches.
func TestUpstreamContextIncludesResearchFindings(t *testing.T) {
	state := &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: "/tmp/repo", Name: "demo"}},
		Missions: []domain.Mission{
			{
				ID:           "r1",
				RepositoryID: "repo_1",
				Kind:         domain.MissionKindResearch,
				Text:         "how does the plan engine work?",
				Status:       domain.MissionStatusVerified,
				Document:     "# Findings\nThe plan engine reads state and calls claude.",
			},
			{ID: "t1", RepositoryID: "repo_1", Text: "wire the planner", Status: domain.MissionStatusDraft, DependsOn: []string{"r1"}},
		},
	}

	contextBlock, titles := upstreamContextFor(state, state.Missions[1])

	if len(titles) != 1 || titles[0] != "how does the plan engine work?" {
		t.Fatalf("titles = %v, want [how does the plan engine work?]", titles)
	}
	if !strings.Contains(contextBlock, "Findings:\n# Findings\nThe plan engine reads state and calls claude.") {
		t.Fatalf("context missing findings block:\n%s", contextBlock)
	}
	if strings.Contains(contextBlock, "```diff") {
		t.Fatalf("research upstream should not carry a diff block:\n%s", contextBlock)
	}
}

// A mission generated from a plan gets that plan's document prepended to its
// context, so the concise task text is backed by the detail the planner wrote.
func TestUpstreamContextIncludesPlanDocument(t *testing.T) {
	state := &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: "/tmp/repo", Name: "demo"}},
		Plans: []domain.Plan{
			{ID: "plan_1", RepositoryID: "repo_1", Content: "# Plan\nDetailed reasoning about the parser rewrite."},
		},
		Missions: []domain.Mission{
			{ID: "t1", RepositoryID: "repo_1", Text: "add the parser", PlanID: "plan_1", Status: domain.MissionStatusDraft},
		},
	}

	contextBlock, titles := upstreamContextFor(state, state.Missions[0])

	if titles != nil {
		t.Fatalf("titles = %v, want nil (no upstream deps)", titles)
	}
	if !strings.Contains(contextBlock, "# Plan") || !strings.Contains(contextBlock, "Detailed reasoning about the parser rewrite.") {
		t.Fatalf("context missing plan document:\n%s", contextBlock)
	}
}

// A mission with both a plan and an upstream dependency gets both blocks.
func TestUpstreamContextCombinesPlanAndUpstream(t *testing.T) {
	state := chainedState("/tmp/repo")
	state.Plans = []domain.Plan{{ID: "plan_1", RepositoryID: "repo_1", Content: "# Plan\nBuild the parser then wire it in."}}
	state.Missions[1].PlanID = "plan_1"

	contextBlock, titles := upstreamContextFor(state, state.Missions[1])

	if len(titles) != 1 || titles[0] != "add a parser" {
		t.Fatalf("titles = %v, want [add a parser]", titles)
	}
	if !strings.Contains(contextBlock, "Build the parser then wire it in.") {
		t.Fatalf("context missing plan document:\n%s", contextBlock)
	}
	if !strings.Contains(contextBlock, "## Upstream task: add a parser") {
		t.Fatalf("context missing upstream section:\n%s", contextBlock)
	}
}

func TestStartAgentRunRecordsUpstreamHandoff(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	svc := NewService(jsonStore)
	repoDir := t.TempDir()

	if err := jsonStore.Save(chainedState(repoDir)); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := svc.StartAgentRun(context.Background(), "m2", "mock"); err != nil {
		t.Fatalf("StartAgentRun() error = %v", err)
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	found := false
	for _, event := range state.WorkflowEvents {
		if event.MissionID == "m2" && strings.Contains(event.Message, "Received hand-off from “add a parser”") {
			found = true
		}
	}
	if !found {
		t.Fatal("expected a hand-off workflow event for the chained mission")
	}
}
