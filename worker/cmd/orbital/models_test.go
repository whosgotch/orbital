package main

import (
	"strings"
	"testing"
)

// A trimmed stand-in for the records embedded in the claude binary: the field
// order matters (advisor_rank last), so truncation tests mirror reality.
const catalogFixture = `noise noise {id:"claude-sonnet-4-6",family:"sonnet",display_name:"Sonnet 4.6",` +
	`context:{window:1e6},capabilities:["effort","max_effort","context_management"],advisor_rank:2},` +
	`{id:"claude-opus-5",family:"opus",display_name:"Opus 5",` +
	`capabilities:["effort","max_effort","xhigh_effort"],default_effort:"high",advisor_rank:4},` +
	`{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5",` +
	`capabilities:["context_management"],advisor_rank:1},` +
	`{id:"claude-mythos-5",family:"mythos",display_name:"Mythos 5",advisor_rank:5},` +
	`{id:"claude-opus-4-1",family:"opus",display_name:"Opus 4.1",capabilities:["effort"]} trailing`

func TestParseModelCatalogReadsEmbeddedRecords(t *testing.T) {
	models := parseModelCatalog(strings.NewReader(catalogFixture))

	// Newest first by advisor_rank; mythos (not an offered family) and Opus 4.1
	// (no advisor_rank, so no longer offered) are both left out.
	wantIDs := []string{"claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5"}
	if len(models) != len(wantIDs) {
		t.Fatalf("got %d models %v, want %d", len(models), models, len(wantIDs))
	}
	for i, want := range wantIDs {
		if models[i].ID != want {
			t.Errorf("model %d = %q, want %q", i, models[i].ID, want)
		}
	}

	if models[0].DisplayName != "Opus 5" || models[0].DefaultEffort != "high" {
		t.Errorf("opus 5 = %+v, want display name and default effort", models[0])
	}
	if got := strings.Join(models[0].EffortLevels, ","); got != "low,medium,high,xhigh,max" {
		t.Errorf("opus 5 effort levels = %q", got)
	}
	// Sonnet 4.6 has max_effort but not xhigh_effort.
	if got := strings.Join(models[1].EffortLevels, ","); got != "low,medium,high,max" {
		t.Errorf("sonnet 4.6 effort levels = %q", got)
	}
	// Haiku has no effort capability at all: no levels, so --effort is not sent.
	if len(models[2].EffortLevels) != 0 || models[2].DefaultEffort != "" {
		t.Errorf("haiku = %+v, want no effort levels", models[2])
	}
}

// The real binary is read in chunks, so a record straddling a boundary must
// still be parsed exactly once.
func TestParseModelCatalogSpansChunkBoundaries(t *testing.T) {
	padded := strings.Repeat("x", (1<<20)-120) + catalogFixture
	models := parseModelCatalog(strings.NewReader(padded))

	if len(models) != 3 {
		t.Fatalf("got %d models %v, want 3", len(models), models)
	}
	if models[0].ID != "claude-opus-5" || models[0].DefaultEffort != "high" {
		t.Errorf("straddling record parsed as %+v", models[0])
	}
}

func TestParseModelCatalogIgnoresGarbage(t *testing.T) {
	if models := parseModelCatalog(strings.NewReader("not a claude binary")); len(models) != 0 {
		t.Errorf("got %v, want no models", models)
	}
}

func TestEffortLevelsRequireTheEffortCapability(t *testing.T) {
	if levels := effortLevels(`"context_management","fast_mode"`); levels != nil {
		t.Errorf("got %v, want nil for a model without effort", levels)
	}
	// "max_effort" must not be mistaken for the plain "effort" capability.
	if levels := effortLevels(`"max_effort"`); levels != nil {
		t.Errorf("got %v, want nil when only max_effort is present", levels)
	}
}
