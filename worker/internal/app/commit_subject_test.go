package app

import "testing"

func TestCommitSubjectPrefersSuggested(t *testing.T) {
	got := commitSubject("feat(app): add effort picker", "Add option to select thinking level of model")
	if got != "feat(app): add effort picker" {
		t.Fatalf("subject = %q", got)
	}
}

func TestCommitSubjectFallsBackToMissionTextWhenNoSuggestion(t *testing.T) {
	got := commitSubject("", "Add option to select thinking level of model")
	if got != "Add option to select thinking level of model" {
		t.Fatalf("subject = %q", got)
	}
}

func TestCommitSubjectTakesFirstLineOfSuggestion(t *testing.T) {
	got := commitSubject("feat(app): add effort picker\nSome extra body the model added anyway.", "mission text")
	if got != "feat(app): add effort picker" {
		t.Fatalf("subject = %q", got)
	}
}

func TestCommitSubjectCapsSuggestionLength(t *testing.T) {
	long := "feat(app): a very long subject line that goes well beyond seventy two characters total"
	got := commitSubject(long, "mission text")
	if len(got) != 72 {
		t.Fatalf("subject length = %d, want 72: %q", len(got), got)
	}
}
