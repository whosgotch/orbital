package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// modelInfo is what the app's model picker renders: the id is passed to
// `claude --model`, the display name is what the user sees. EffortLevels are
// the `--effort` values this particular model accepts — empty means the model
// has no thinking levels at all and --effort must not be sent.
type modelInfo struct {
	ID            string   `json:"id"`
	DisplayName   string   `json:"display_name"`
	EffortLevels  []string `json:"effort_levels"`
	DefaultEffort string   `json:"default_effort,omitempty"`
}

// modelCatalog is the whole picker payload: the model list plus whatever the
// user already configured in Claude Code, so Orbital opens on the same model
// they are using in the CLI instead of its own invented default.
type modelCatalog struct {
	Models        []modelInfo `json:"models"`
	DefaultModel  string      `json:"default_model,omitempty"`
	DefaultEffort string      `json:"default_effort,omitempty"`
}

// listModels prints the model catalog as JSON. The catalog is read out of the
// installed claude binary, which carries the authoritative list for the exact
// CLI version we shell out to — so a `claude update` brings new models to
// Orbital with no release of our own. A hardcoded list is only the last resort
// for when that parse finds nothing.
func listModels(args []string, stdout io.Writer) error {
	if len(args) != 2 {
		return usageError()
	}

	models := modelsFromCLI()
	if len(models) == 0 {
		models = fallbackModels()
	}

	defaultModel, defaultEffort := claudeCodeDefaults()
	data, err := json.Marshal(modelCatalog{
		Models:        models,
		DefaultModel:  defaultModel,
		DefaultEffort: defaultEffort,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, string(data))
	return err
}

// The claude binary embeds its model catalog as JS object literals, one per
// model, e.g.
//
//	{id:"claude-sonnet-5",family:"sonnet",display_name:"Sonnet 5",...,
//	 capabilities:["effort","max_effort","xhigh_effort",...],
//	 default_effort:"high",advisor_rank:3}
//
// advisor_rank marks the tiers the CLI still offers; legacy models carry none.
var (
	recordMarker = []byte(`{id:"claude-`)
	recordHead   = regexp.MustCompile(`^\{id:"([a-z0-9-]+)",family:"([a-z]+)",display_name:"([^"]+)"`)
	recordRank   = regexp.MustCompile(`advisor_rank:(\d+)`)
	recordCaps   = regexp.MustCompile(`capabilities:\[([^\]]*)\]`)
	recordEffort = regexp.MustCompile(`default_effort:"([a-z]+)"`)
)

// offeredFamilies mirrors the CLI's own family list — it keeps non-coding
// models (mythos) out of a picker that only ever launches coding runs.
var offeredFamilies = map[string]bool{"opus": true, "sonnet": true, "haiku": true, "fable": true}

// maxRecordLen bounds how far past a record's start we look for its fields;
// the longest real record is well under this.
const maxRecordLen = 2000

type catalogEntry struct {
	model modelInfo
	rank  int
	order int
}

// modelsFromCLI parses the catalog out of the installed claude binary. Any
// failure returns nil so the caller falls back to the static list — the picker
// must never break the app.
func modelsFromCLI() []modelInfo {
	path, err := claudeBinaryPath()
	if err != nil {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()

	return parseModelCatalog(file)
}

// claudeBinaryPath resolves `claude` on PATH through any symlinks, since the
// installer puts a link in ~/.local/bin pointing at the versioned binary.
func claudeBinaryPath() (string, error) {
	path, err := exec.LookPath("claude")
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path, nil
	}
	return resolved, nil
}

// parseModelCatalog scans for embedded model records. The binary is hundreds of
// megabytes, so it is read in chunks that overlap by one record length — that
// way a record straddling a chunk boundary is still seen whole.
func parseModelCatalog(r io.Reader) []modelInfo {
	const chunkSize = 1 << 20

	seen := map[string]bool{}
	var entries []catalogEntry
	buf := make([]byte, 0, chunkSize+maxRecordLen)
	chunk := make([]byte, chunkSize)

	for {
		n, err := r.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			collectRecords(buf, seen, &entries)
			if len(buf) > maxRecordLen {
				buf = append(buf[:0], buf[len(buf)-maxRecordLen:]...)
			}
		}
		if err != nil {
			break
		}
	}

	// Newest first: higher advisor_rank leads, and within one rank the model
	// declared later in the catalog is the newer one.
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].rank != entries[j].rank {
			return entries[i].rank > entries[j].rank
		}
		return entries[i].order > entries[j].order
	})

	models := make([]modelInfo, 0, len(entries))
	for _, entry := range entries {
		models = append(models, entry.model)
	}
	return models
}

func collectRecords(buf []byte, seen map[string]bool, entries *[]catalogEntry) {
	for offset := 0; ; {
		index := bytes.Index(buf[offset:], recordMarker)
		if index < 0 {
			return
		}
		start := offset + index
		end := start + maxRecordLen
		if end > len(buf) {
			end = len(buf)
		}
		// Stop at the next record so fields are never read from a neighbour.
		if next := bytes.Index(buf[start+1:end], recordMarker); next >= 0 {
			end = start + 1 + next
		}
		if entry, ok := parseRecord(buf[start:end]); ok && !seen[entry.model.ID] {
			seen[entry.model.ID] = true
			entry.order = len(*entries)
			*entries = append(*entries, entry)
		}
		offset = start + 1
	}
}

func parseRecord(record []byte) (catalogEntry, bool) {
	head := recordHead.FindSubmatch(record)
	if head == nil {
		return catalogEntry{}, false
	}
	if !offeredFamilies[string(head[2])] {
		return catalogEntry{}, false
	}
	// No advisor_rank means the CLI no longer offers the model.
	rankMatch := recordRank.FindSubmatch(record)
	if rankMatch == nil {
		return catalogEntry{}, false
	}
	rank, err := strconv.Atoi(string(rankMatch[1]))
	if err != nil {
		return catalogEntry{}, false
	}

	capabilities := ""
	if caps := recordCaps.FindSubmatch(record); caps != nil {
		capabilities = string(caps[1])
	}
	defaultEffort := ""
	if effort := recordEffort.FindSubmatch(record); effort != nil {
		defaultEffort = string(effort[1])
	}

	// Always a list, never null, so the app can map over it unguarded.
	levels := effortLevels(capabilities)
	if len(levels) == 0 {
		levels, defaultEffort = []string{}, ""
	}

	return catalogEntry{
		model: modelInfo{
			ID:            string(head[1]),
			DisplayName:   string(head[3]),
			EffortLevels:  levels,
			DefaultEffort: defaultEffort,
		},
		rank: rank,
	}, true
}

// effortLevels turns the model's capability flags into the exact values
// `claude --effort` accepts for it. A model without the "effort" capability
// has no thinking levels and must be launched without the flag.
func effortLevels(capabilities string) []string {
	has := func(name string) bool {
		return strings.Contains(capabilities, `"`+name+`"`)
	}
	if !has("effort") {
		return nil
	}
	levels := []string{"low", "medium", "high"}
	if has("xhigh_effort") {
		levels = append(levels, "xhigh")
	}
	if has("max_effort") {
		levels = append(levels, "max")
	}
	return levels
}

// claudeCodeDefaults reports the model and thinking level the user already
// picked in Claude Code, so Orbital starts where the CLI does. ANTHROPIC_MODEL
// wins over the settings file, matching the CLI's own precedence.
func claudeCodeDefaults() (model, effort string) {
	home, err := os.UserHomeDir()
	if err == nil {
		data, readErr := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
		if readErr == nil {
			var settings struct {
				Model       string `json:"model"`
				EffortLevel string `json:"effortLevel"`
			}
			if json.Unmarshal(data, &settings) == nil {
				model, effort = settings.Model, settings.EffortLevel
			}
		}
	}
	if env := os.Getenv("ANTHROPIC_MODEL"); env != "" {
		model = env
	}
	return model, effort
}

// fallbackModels is the last resort for when the installed CLI cannot be read.
// It is deliberately short — the parse above is the real source, and a stale
// list here is better than an empty picker.
func fallbackModels() []modelInfo {
	full := []string{"low", "medium", "high", "xhigh", "max"}
	return []modelInfo{
		{ID: "claude-fable-5", DisplayName: "Fable 5", EffortLevels: full, DefaultEffort: "high"},
		{ID: "claude-opus-5", DisplayName: "Opus 5", EffortLevels: full, DefaultEffort: "high"},
		{ID: "claude-sonnet-5", DisplayName: "Sonnet 5", EffortLevels: full, DefaultEffort: "high"},
		{ID: "claude-haiku-4-5", DisplayName: "Haiku 4.5", EffortLevels: []string{}},
	}
}
