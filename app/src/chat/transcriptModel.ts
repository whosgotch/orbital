import type { TranscriptEntry } from "./AgentTranscript";
import type { ChatMessage, MissionLoopState, WorkflowEvent } from "../workspace/domain";
import { roleLabel } from "../workspace/workspaceAdapter";

// A run's worker name, resolved to its display label; shared by the
// whole-mission transcript and the per-message slices below.
function labelForRunFactory(state: MissionLoopState): (runId: string | undefined) => string {
  const runById = new Map(state.agent_runs.map((run) => [run.id, run]));
  return (rid: string | undefined) => {
    const run = rid ? runById.get(rid) : undefined;
    return run ? roleLabel(run.worker_name) : "";
  };
}

// The one place a workflow event becomes a transcript entry — reused by both
// the whole-mission transcript and the per-message slices so they read
// identically.
function eventToEntry(event: WorkflowEvent, labelForRun: (rid: string | undefined) => string): TranscriptEntry {
  const kind =
    event.type === "agent_reasoning"
      ? "reasoning"
      : event.type === "agent_thought"
        ? "thought"
        : event.type === "agent_action" || event.type === "command_executed" || event.type === "file_read"
          ? "action"
          : "status";
  return { id: event.id, kind, text: event.message, agent: labelForRun(event.run_id) } as TranscriptEntry;
}

// The whole mission's agents, in order.
export function buildAgentTranscript(state: MissionLoopState, missionId: string): TranscriptEntry[] {
  const labelForRun = labelForRunFactory(state);
  // Cluster each agent's events together by ordering on when its run started,
  // then chronologically within the run — so the mission-wide view reads
  // manager → engineer rather than interleaving them.
  const runById = new Map(state.agent_runs.map((run) => [run.id, run]));
  const runStart = (rid: string | undefined) => (rid ? runById.get(rid)?.started_at ?? "" : "");

  return state.workflow_events
    .filter((event) => event.mission_id === missionId)
    .slice()
    .sort((a, b) => runStart(a.run_id).localeCompare(runStart(b.run_id)) || a.created_at.localeCompare(b.created_at))
    .map((event) => eventToEntry(event, labelForRun))
    .filter((entry) => entry.text.trim() !== "");
}

// Each assistant message gets the workflow events between the previous assistant reply (exclusive) and this one (inclusive).
// Events aren't filtered by run_id — a multi-agent mission (manager + engineer) feeds a single reply, so the whole window belongs to that turn.
// Events newer than the last assistant message are the in-flight turn, shown live rather than pinned to a bubble.
export function sliceTranscriptByMessage(
  state: MissionLoopState,
  missionId: string,
  messages: ChatMessage[],
): Record<string, TranscriptEntry[]> {
  const labelForRun = labelForRunFactory(state);
  const events = state.workflow_events
    .filter((event) => event.mission_id === missionId)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const result: Record<string, TranscriptEntry[]> = {};
  let lowerBound = "";
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const upperBound = message.created_at;
    result[message.id] = events
      .filter((event) => event.created_at > lowerBound && event.created_at <= upperBound)
      .map((event) => eventToEntry(event, labelForRun))
      .filter((entry) => entry.text.trim() !== "");
    lowerBound = upperBound;
  }
  return result;
}

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
