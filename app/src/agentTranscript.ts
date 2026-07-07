import type { TranscriptEntry } from "./components/AgentTranscript";
import type { ChatMessage, MissionLoopState } from "./domain";
import { roleLabel } from "./workspaceAdapter";

// buildAgentTranscript turns persisted workflow events into the agent's
// thoughts + actions stream, scoped to one run when a specific agent is
// selected, otherwise the whole mission's agents in order.
export function buildAgentTranscript(state: MissionLoopState, missionId: string, runId: string | undefined): TranscriptEntry[] {
  const runById = new Map(state.agent_runs.map((run) => [run.id, run]));
  const labelForRun = (rid: string | undefined) => {
    const run = rid ? runById.get(rid) : undefined;
    return run ? roleLabel(run.worker_name) : "";
  };
  // Cluster each agent's events together by ordering on when its run started,
  // then chronologically within the run — so the mission-wide view reads
  // manager → engineer rather than interleaving them.
  const runStart = (rid: string | undefined) => (rid ? runById.get(rid)?.started_at ?? "" : "");

  return state.workflow_events
    .filter((event) => {
      if (runId) return event.run_id === runId;
      return event.mission_id === missionId;
    })
    .slice()
    .sort((a, b) => runStart(a.run_id).localeCompare(runStart(b.run_id)) || a.created_at.localeCompare(b.created_at))
    .map((event) => {
      const kind =
        event.type === "agent_thought"
          ? "thought"
          : event.type === "agent_action" || event.type === "command_executed" || event.type === "file_read"
            ? "action"
            : "status";
      return { id: event.id, kind, text: event.message, agent: labelForRun(event.run_id) } as TranscriptEntry;
    })
    .filter((entry) => entry.text.trim() !== "");
}

// groupChatByMission buckets the flat chat log into per-mission conversations,
// each ordered oldest-first so the thread reads top to bottom.
export function groupChatByMission(messages: ChatMessage[]): Record<string, ChatMessage[]> {
  const byMission: Record<string, ChatMessage[]> = {};
  for (const message of messages) {
    (byMission[message.mission_id] ??= []).push(message);
  }
  for (const list of Object.values(byMission)) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return byMission;
}
