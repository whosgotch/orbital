package app

import (
	"fmt"
	"strings"

	"github.com/whosgotch/orbital/worker/internal/domain"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// Caps keep the injected context bounded: an upstream's diff can be huge, but
// downstream agents only need enough to understand what landed — they can read
// the real files in the repository.
const (
	upstreamDiffLimit     = 6000
	upstreamSummaryLimit  = 1200
	upstreamFindingsLimit = 6000
)

// upstreamContextFor composes what flows into a mission's run prompt besides
// its own task text: for every upstream it depends on, that upstream's task
// text, the agent's final summary, and the diff that landed (or, for
// research, its findings document). Returns the prompt block and the upstream
// titles (for the hand-off event); the block is empty when there are no
// upstreams.
func upstreamContextFor(state *store.State, mission domain.Mission) (string, []string) {
	var blocks []string
	var titles []string
	if len(mission.DependsOn) > 0 {
		var sections []string
		for _, upstreamID := range mission.DependsOn {
			index := findMissionIndex(state.Missions, upstreamID)
			if index == -1 {
				continue
			}
			upstream := state.Missions[index]
			titles = append(titles, upstream.Text)

			section := fmt.Sprintf("## Upstream task: %s", upstream.Text)
			if summary := lastAssistantMessage(state, upstreamID); summary != "" {
				section += "\nOutcome: " + truncateContext(summary, upstreamSummaryLimit)
			}
			// Research produces a findings document, not a patch — hand that down
			// instead of a diff. Research missions never emit patches, so the diff
			// branch below naturally stays empty for them.
			if upstream.IsResearch() && strings.TrimSpace(upstream.Document) != "" {
				section += "\nFindings:\n" + truncateContext(upstream.Document, upstreamFindingsLimit)
			} else if diff := latestMissionDiff(state, upstreamID); diff != "" {
				section += "\nChanges it landed:\n```diff\n" + truncateContext(diff, upstreamDiffLimit) + "\n```"
			}
			sections = append(sections, section)
		}
		if len(sections) > 0 {
			header := "# Context from upstream tasks\nThis task depends on tasks that already completed; their changes are in the repository. Build on them.\n"
			blocks = append(blocks, header+"\n"+strings.Join(sections, "\n\n"))
		}
	}

	if len(blocks) == 0 {
		return "", nil
	}
	return strings.Join(blocks, "\n\n"), titles
}

// lastAssistantMessage is the upstream agent's own closing summary of what it
// did — the most useful single line to hand downstream.
func lastAssistantMessage(state *store.State, missionID string) string {
	for index := len(state.ChatMessages) - 1; index >= 0; index-- {
		message := state.ChatMessages[index]
		if message.MissionID == missionID && message.Role == domain.ChatRoleAssistant {
			return strings.TrimSpace(message.Text)
		}
	}
	return ""
}

// latestMissionDiff is the newest patch produced by any of the mission's runs.
// Chained tasks only start after the upstream landed, so this is the diff that
// was approved and applied.
func latestMissionDiff(state *store.State, missionID string) string {
	runIDs := make(map[string]bool)
	for _, run := range state.AgentRuns {
		if run.MissionID == missionID {
			runIDs[run.ID] = true
		}
	}

	for index := len(state.PatchProposals) - 1; index >= 0; index-- {
		patch := state.PatchProposals[index]
		if runIDs[patch.RunID] {
			return strings.TrimSpace(patch.Diff)
		}
	}
	return ""
}

func truncateContext(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "\n… [truncated]"
}
