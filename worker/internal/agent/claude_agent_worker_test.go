package agent

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A diff whose final hunk line is a context line for a blank line in the file:
// git writes that as a lone space (" "). Dropping it leaves the body one line
// short of the "-1,3" the header counts, which git apply rejects as "corrupt
// patch".
func TestNormalizeCapturedDiffKeepsTrailingBlankContextLine(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.email", "t@t")
	runGit(t, repo, "config", "user.name", "t")

	// File whose third (and last) line is blank.
	const original = "from pprint import pprint\nimport urllib.request, json\n\n"
	target := filepath.Join(repo, "app.py")
	if err := os.WriteFile(target, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "-A")
	runGit(t, repo, "commit", "-m", "base")

	// Make a change so git produces a hunk that ends on the blank context line.
	if err := os.WriteFile(target, []byte("# header\n"+original), 0644); err != nil {
		t.Fatal(err)
	}
	rawDiff := runGit(t, repo, "diff")

	normalized := normalizeCapturedDiff(rawDiff)

	// The space-only context line must survive normalization.
	if !strings.Contains(normalized, "\n \n") && !strings.HasSuffix(normalized, "\n ") {
		t.Fatalf("normalized diff lost its blank context line:\n%q", normalized)
	}

	// Reset the file, then prove the stored patch (normalized + one newline, as
	// the worker writes it) applies cleanly.
	if err := os.WriteFile(target, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	apply := exec.Command("git", "apply")
	apply.Dir = repo
	apply.Stdin = strings.NewReader(normalized + "\n")
	if out, err := apply.CombinedOutput(); err != nil {
		t.Fatalf("git apply rejected normalized diff: %v: %s", err, out)
	}
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

func TestSplitResearchReply(t *testing.T) {
	note, findings := splitResearchReply("<note>Found it.</note>\n<findings># Doc\n\nBody.</findings>")
	if note != "Found it." {
		t.Fatalf("note = %q", note)
	}
	if findings != "# Doc\n\nBody." {
		t.Fatalf("findings = %q", findings)
	}
}

func TestSplitResearchReplyWithoutTagsKeepsDocument(t *testing.T) {
	note, findings := splitResearchReply("just a plain answer")
	if findings != "just a plain answer" {
		t.Fatalf("findings = %q", findings)
	}
	if note == "" {
		t.Fatal("expected a stock note")
	}
}

func TestSplitResearchReplyUnclosedFindingsTag(t *testing.T) {
	_, findings := splitResearchReply("<note>n</note><findings># Doc without closing tag")
	if findings != "# Doc without closing tag" {
		t.Fatalf("findings = %q", findings)
	}
}
