package app

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

func extractState(t *testing.T, document string) (*store.JSONStore, string) {
	t.Helper()
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "r1", RepositoryID: "repo_1", Kind: domain.MissionKindResearch, Text: "how does auth work?", Status: domain.MissionStatusVerified, Document: document},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	return jsonStore, "r1"
}

// Extracting from a research document parses the proposed tasks, chains each
// one after the research mission (so its findings flow down via the ordinary
// upstream hand-off), and persists them as draft missions.
func TestExtractTasksCreatesMissionsChainedToResearchNode(t *testing.T) {
	jsonStore, missionID := extractState(t, "# Findings\nAuth uses JWTs signed with HS256.")
	svc := NewService(jsonStore)
	svc.SetExtractor(func(ctx context.Context, model, repoPath, document, graphContext string, onStep func(kind, text string)) ([]ProposedSubtask, error) {
		if !strings.Contains(document, "Auth uses JWTs") {
			t.Fatalf("extractor did not receive the research document: %q", document)
		}
		return []ProposedSubtask{
			{Title: "rotate keys", Text: "add key rotation for the JWT signer"},
			{Title: "add tests", Text: "cover the rotation with a unit test", DependsOn: []int{0}},
		}, nil
	})

	created, err := svc.ExtractTasks(context.Background(), missionID)
	if err != nil {
		t.Fatalf("ExtractTasks() error = %v", err)
	}
	if len(created) != 2 {
		t.Fatalf("created = %d, want 2", len(created))
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.Missions) != 3 {
		t.Fatalf("expected 3 missions persisted (research + 2 extracted), got %d", len(state.Missions))
	}

	var rotate, tests domain.Mission
	for _, m := range state.Missions {
		switch m.Text {
		case "add key rotation for the JWT signer":
			rotate = m
		case "cover the rotation with a unit test":
			tests = m
		}
	}
	if rotate.ID == "" || tests.ID == "" {
		t.Fatal("expected both extracted tasks present")
	}
	if len(rotate.DependsOn) != 1 || rotate.DependsOn[0] != missionID {
		t.Fatalf("rotate.DependsOn = %v, want [%s]", rotate.DependsOn, missionID)
	}
	// The second task depends on the first sibling AND the research node.
	if len(tests.DependsOn) != 2 || !containsString(tests.DependsOn, rotate.ID) || !containsString(tests.DependsOn, missionID) {
		t.Fatalf("tests.DependsOn = %v, want [%s, %s] in some order", tests.DependsOn, rotate.ID, missionID)
	}
	for _, m := range created {
		if m.Status != domain.MissionStatusDraft {
			t.Fatalf("extracted mission %s should be a draft, got %s", m.ID, m.Status)
		}
	}
}

func TestExtractTasksRejectsNonResearchMission(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions:     []domain.Mission{{ID: "t1", RepositoryID: "repo_1", Kind: domain.MissionKindTask, Text: "do a thing", Status: domain.MissionStatusDraft}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	svc := NewService(jsonStore)

	if _, err := svc.ExtractTasks(context.Background(), "t1"); err == nil {
		t.Fatal("ExtractTasks() on a non-research mission should error")
	}
}

func TestExtractTasksRejectsEmptyDocument(t *testing.T) {
	jsonStore, missionID := extractState(t, "")
	svc := NewService(jsonStore)

	if _, err := svc.ExtractTasks(context.Background(), missionID); err == nil {
		t.Fatal("ExtractTasks() on an empty document should error")
	}
}

func TestExtractTasksRejectsUnknownMission(t *testing.T) {
	jsonStore, _ := extractState(t, "# Findings\nsomething")
	svc := NewService(jsonStore)

	if _, err := svc.ExtractTasks(context.Background(), "nope"); err == nil {
		t.Fatal("ExtractTasks() with unknown mission should error")
	}
}

func TestExtractTasksRejectsZeroProposedTasks(t *testing.T) {
	jsonStore, missionID := extractState(t, "# Findings\nnothing actionable")
	svc := NewService(jsonStore)
	svc.SetExtractor(func(ctx context.Context, model, repoPath, document, graphContext string, onStep func(kind, text string)) ([]ProposedSubtask, error) {
		return nil, nil
	})

	if _, err := svc.ExtractTasks(context.Background(), missionID); err == nil {
		t.Fatal("ExtractTasks() with zero proposed tasks should error")
	}
}

// A prose reply (no JSON contract) triggers exactly one repair call; when the
// repair reply parses, its subtasks are used.
func TestExtractWithRepairFixesProseReplyOnSuccessfulRepair(t *testing.T) {
	calls := 0
	query := func(ctx context.Context, repoPath, model, prompt string, onStep func(kind, text string)) (string, error) {
		calls++
		if calls == 1 {
			return "Sure, here's what I'd do: rotate the keys, then add a test.", nil
		}
		return `{"subtasks":[{"title":"rotate","text":"rotate keys"},{"title":"test","text":"add a test"}]}`, nil
	}

	var steps []string
	onStep := func(kind, text string) { steps = append(steps, text) }

	subtasks, err := extractWithRepair(context.Background(), query, "model", "/repo", "# Findings\nkeys never rotate", "", onStep)
	if err != nil {
		t.Fatalf("extractWithRepair() error = %v", err)
	}
	if calls != 2 {
		t.Fatalf("query calls = %d, want 2 (extract + repair)", calls)
	}
	if len(subtasks) != 2 {
		t.Fatalf("subtasks = %+v, want 2 repaired tasks", subtasks)
	}
	found := false
	for _, s := range steps {
		if strings.Contains(s, "repairing extraction output") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a step announcing the repair, got %v", steps)
	}
}

// When the repair call itself still doesn't produce parseable JSON,
// extraction has nothing to salvage (unlike planning, there's no prose
// document to fall back to) and returns an error.
func TestExtractWithRepairErrorsWhenRepairFails(t *testing.T) {
	calls := 0
	query := func(ctx context.Context, repoPath, model, prompt string, onStep func(kind, text string)) (string, error) {
		calls++
		if calls == 1 {
			return "Sure, here's what I'd do.", nil
		}
		return "Sorry, still not JSON.", nil
	}

	if _, err := extractWithRepair(context.Background(), query, "model", "/repo", "# Findings", "", func(string, string) {}); err == nil {
		t.Fatal("extractWithRepair() should error when repair also fails to parse")
	}
	if calls != 2 {
		t.Fatalf("query calls = %d, want 2 (extract + repair attempt)", calls)
	}
}

// A reply that already carries the JSON contract with subtasks never
// triggers a repair call.
func TestExtractWithRepairSkipsRepairWhenSubtasksPresent(t *testing.T) {
	calls := 0
	query := func(ctx context.Context, repoPath, model, prompt string, onStep func(kind, text string)) (string, error) {
		calls++
		return `{"subtasks":[{"title":"a","text":"do a"}]}`, nil
	}

	subtasks, err := extractWithRepair(context.Background(), query, "model", "/repo", "# Findings", "", func(string, string) {})
	if err != nil {
		t.Fatalf("extractWithRepair() error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("query calls = %d, want 1 (no repair)", calls)
	}
	if len(subtasks) != 1 {
		t.Fatalf("subtasks = %+v", subtasks)
	}
}

func TestParseExtractResultToleratesFences(t *testing.T) {
	subtasks, ok := parseExtractResult("```json\n{\"subtasks\":[{\"title\":\"a\",\"text\":\"do a\"}]}\n```")
	if !ok {
		t.Fatal("parseExtractResult() should have parsed fenced JSON")
	}
	if len(subtasks) != 1 {
		t.Fatalf("subtasks = %+v", subtasks)
	}

	if _, ok := parseExtractResult("not json at all"); ok {
		t.Fatal("parseExtractResult() should reject non-JSON prose")
	}
}

// Extractor steps stream as EVENT: NDJSON lines on eventOut, and are ephemeral —
// none of them end up persisted in the state.
func TestExtractTasksStreamsStepsWithoutPersistingThem(t *testing.T) {
	jsonStore, missionID := extractState(t, "# Findings\nsomething actionable")
	svc := NewService(jsonStore)
	var out bytes.Buffer
	svc.SetEventOut(&out)
	svc.SetExtractor(func(ctx context.Context, model, repoPath, document, graphContext string, onStep func(kind, text string)) ([]ProposedSubtask, error) {
		onStep("thought", "reading the findings")
		onStep("action", "drafting tasks")
		return []ProposedSubtask{{Text: "do it"}}, nil
	})

	if _, err := svc.ExtractTasks(context.Background(), missionID); err != nil {
		t.Fatalf("ExtractTasks() error = %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "EVENT:") || !strings.HasPrefix(lines[1], "EVENT:") {
		t.Fatalf("streamed lines = %q, want two EVENT: lines", out.String())
	}

	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(state.WorkflowEvents) != 0 {
		t.Fatalf("extraction steps must not persist, got %+v", state.WorkflowEvents)
	}
}

// The graph index numbers each mission of the repo oldest-to-newest, marks
// done ones (verified or applied) with their outcome, and returns a parallel
// ID slice where only done entries carry a real ID.
func TestGraphIndexForNumbersDoneAndDraftMissions(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	state := &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "m1", RepositoryID: "repo_1", Kind: domain.MissionKindResearch, Text: "how does the extractor work?\nmore detail", Status: domain.MissionStatusVerified},
			{ID: "m2", RepositoryID: "repo_1", Kind: domain.MissionKindTask, Text: "wire the extractor", Status: domain.MissionStatusDraft},
			{ID: "other", RepositoryID: "repo_2", Kind: domain.MissionKindTask, Text: "unrelated repo", Status: domain.MissionStatusVerified},
		},
		ChatMessages: []domain.ChatMessage{
			{ID: "c1", MissionID: "m1", RunID: "run_1", Role: domain.ChatRoleAssistant, Text: "The extractor reads state and calls claude."},
		},
	}
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	index, ids := graphIndexFor(loaded, "repo_1")

	if !strings.Contains(index, "N1 [research · done] how does the extractor work? — The extractor reads state and calls claude.") {
		t.Fatalf("index missing done research line:\n%s", index)
	}
	if !strings.Contains(index, "N2 [task · draft] wire the extractor") {
		t.Fatalf("index missing draft task line:\n%s", index)
	}
	if strings.Contains(index, "unrelated repo") {
		t.Fatalf("index leaked another repo's mission:\n%s", index)
	}
	if len(ids) != 2 || ids[0] != "m1" || ids[1] != "" {
		t.Fatalf("ids = %v, want [m1, \"\"]", ids)
	}
}

// Only the last 30 missions of the repo make the index, oldest of the kept
// window first.
func TestGraphIndexForCapsAtThirtyMissions(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	missions := make([]domain.Mission, 0, 35)
	for i := 0; i < 35; i++ {
		missions = append(missions, domain.Mission{
			ID:           fmt.Sprintf("m%d", i),
			RepositoryID: "repo_1",
			Text:         fmt.Sprintf("task %d", i),
			Status:       domain.MissionStatusDraft,
		})
	}
	state := &store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
		Missions:     missions,
	}
	if err := jsonStore.Save(state); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	index, ids := graphIndexFor(loaded, "repo_1")

	if len(ids) != 30 {
		t.Fatalf("ids len = %d, want 30", len(ids))
	}
	if !strings.Contains(index, "task 5") {
		t.Fatalf("index dropped the oldest kept mission (task 5):\n%s", index)
	}
	if strings.Contains(index, "task 4 ") || strings.Contains(index, "task 4\n") {
		t.Fatalf("index kept a mission outside the 30 cap:\n%s", index)
	}
	if !strings.Contains(index, "task 34") {
		t.Fatalf("index missing the newest mission:\n%s", index)
	}
}

// No missions in the repo yields an empty index and no IDs.
func TestGraphIndexForEmptyWithNoMissions(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: t.TempDir(), Name: "demo"}},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	state, err := jsonStore.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	index, ids := graphIndexFor(state, "repo_1")

	if index != "" || ids != nil {
		t.Fatalf("expected empty index, got %q / %v", index, ids)
	}
}

// A subtask whose basedOn references an existing verified mission gets that
// mission's real ID appended to its DependsOn; a basedOn pointing at a
// non-linkable (draft) node is ignored.
func TestExtractTasksLinksBasedOnToExistingDoneMissions(t *testing.T) {
	jsonStore := store.NewJSONStore(t.TempDir())
	repoPath := t.TempDir()
	if err := jsonStore.Save(&store.State{
		Repositories: []domain.Repository{{ID: "repo_1", Path: repoPath, Name: "demo"}},
		Missions: []domain.Mission{
			{ID: "old_research", RepositoryID: "repo_1", Kind: domain.MissionKindResearch, Text: "how does auth work?", Status: domain.MissionStatusVerified},
			{ID: "old_draft", RepositoryID: "repo_1", Kind: domain.MissionKindTask, Text: "some unfinished idea", Status: domain.MissionStatusDraft},
			{ID: "r1", RepositoryID: "repo_1", Kind: domain.MissionKindResearch, Text: "how should we add the endpoint?", Status: domain.MissionStatusVerified, Document: "# Findings\nWire it through the auth middleware."},
		},
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	svc := NewService(jsonStore)
	var gotGraphContext string
	svc.SetExtractor(func(ctx context.Context, model, repoPath, document, graphContext string, onStep func(kind, text string)) ([]ProposedSubtask, error) {
		gotGraphContext = graphContext
		return []ProposedSubtask{
			{Title: "wire endpoint", Text: "wire the new endpoint using the auth findings", BasedOn: []int{1, 2}},
		}, nil
	})

	created, err := svc.ExtractTasks(context.Background(), "r1")
	if err != nil {
		t.Fatalf("ExtractTasks() error = %v", err)
	}
	if !strings.Contains(gotGraphContext, "N1 [research · done] how does auth work?") {
		t.Fatalf("extractor did not receive the graph index: %q", gotGraphContext)
	}
	if len(created) != 1 {
		t.Fatalf("created = %d, want 1", len(created))
	}
	// old_draft (N2) is not linkable so basedOn 2 is dropped; basedOn 1
	// resolves to old_research, and the research node itself is always chained.
	if len(created[0].DependsOn) != 2 || !containsString(created[0].DependsOn, "old_research") || !containsString(created[0].DependsOn, "r1") {
		t.Fatalf("DependsOn = %v, want [old_research, r1] (draft node must be ignored)", created[0].DependsOn)
	}
}
