// Pure combinators over MissionLoopState for the multi-repo canvas: the app
// keeps one state slice per open repository and renders the union.
import type { AgentRun, ChatMessage, MissionLoopState, PatchProposal, WorkflowEvent } from "./domain";

export const emptyMissionLoopState: MissionLoopState = {
  repositories: [],
  missions: [],
  agent_runs: [],
  workflow_events: [],
  patch_proposals: [],
  verification_runs: [],
  chat_messages: [],
};

// Merge every open repository's state into one MissionLoopState. The adapter
// already keys nodes by repository_id / mission_id, so the union renders each
// repo as its own cluster on the shared canvas.
export function combineRepoStates(states: Record<string, MissionLoopState>): MissionLoopState {
  const all = Object.values(states);
  return {
    repositories: all.flatMap((state) => state.repositories),
    missions: all.flatMap((state) => state.missions),
    agent_runs: all.flatMap((state) => state.agent_runs),
    workflow_events: all.flatMap((state) => state.workflow_events),
    patch_proposals: all.flatMap((state) => state.patch_proposals),
    verification_runs: all.flatMap((state) => state.verification_runs),
    chat_messages: all.flatMap((state) => state.chat_messages),
  };
}

// Normalize a loaded state into one slice per repository, keyed by repo id.
// Splitting lets each repo be added, updated, or closed on its own.
export function splitByRepository(state: MissionLoopState): Record<string, MissionLoopState> {
  const out: Record<string, MissionLoopState> = {};
  for (const repo of state.repositories) {
    const missionIds = new Set(state.missions.filter((mission) => mission.repository_id === repo.id).map((mission) => mission.id));
    const runIds = new Set(state.agent_runs.filter((run) => missionIds.has(run.mission_id)).map((run) => run.id));
    out[repo.id] = {
      repositories: [repo],
      missions: state.missions.filter((mission) => mission.repository_id === repo.id),
      agent_runs: state.agent_runs.filter((run) => missionIds.has(run.mission_id)),
      workflow_events: state.workflow_events.filter(
        (event) => (event.mission_id != null && missionIds.has(event.mission_id)) || (event.run_id != null && runIds.has(event.run_id)),
      ),
      patch_proposals: state.patch_proposals.filter((patch) => runIds.has(patch.run_id)),
      verification_runs: state.verification_runs.filter((run) => run.repository_id === repo.id || missionIds.has(run.mission_id)),
      chat_messages: state.chat_messages.filter((message) => missionIds.has(message.mission_id) || runIds.has(message.run_id)),
    };
  }
  return out;
}

// Live-stream merges: while a run works, the worker streams each record the
// moment it persists it (RUN:/EVENT:/PATCH:/CHAT: lines). Merging them into the
// combined state keeps the canvas growing in real time; each helper mirrors the
// worker's own persistence rule so the live state converges on the final STATE
// snapshot. All are id-idempotent — replayed records leave the state unchanged.

export function mergeWorkflowEvent(state: MissionLoopState, event: WorkflowEvent): MissionLoopState {
  if (state.workflow_events.some((existing) => existing.id === event.id)) return state;
  return { ...state, workflow_events: [...state.workflow_events, event] };
}

export function mergeChatMessage(state: MissionLoopState, message: ChatMessage): MissionLoopState {
  if (state.chat_messages.some((existing) => existing.id === message.id)) return state;
  return { ...state, chat_messages: [...state.chat_messages, message] };
}

// Upsert a streamed run record. A running run also marks its mission running
// (mirrors StartAgentRun), so the task card pulses from the store's truth.
export function upsertAgentRun(state: MissionLoopState, run: AgentRun): MissionLoopState {
  const exists = state.agent_runs.some((existing) => existing.id === run.id);
  const agent_runs = exists
    ? state.agent_runs.map((existing) => (existing.id === run.id ? run : existing))
    : [...state.agent_runs, run];
  const missions =
    run.status === "running"
      ? state.missions.map((mission) =>
          mission.id === run.mission_id && mission.status !== "running" ? { ...mission, status: "running" as const } : mission,
        )
      : state.missions;
  return { ...state, agent_runs, missions };
}

// Upsert a streamed patch. Mirrors the worker's saveRunEvent: the latest pending
// patch per run replaces a superseded one, and a fresh pending patch parks the
// mission at the approval gate.
export function upsertPatchProposal(state: MissionLoopState, patch: PatchProposal): MissionLoopState {
  const pruned = state.patch_proposals.filter(
    (existing) => existing.id === patch.id || existing.run_id !== patch.run_id || existing.status !== "pending",
  );
  const exists = pruned.some((existing) => existing.id === patch.id);
  const patch_proposals = exists
    ? pruned.map((existing) => (existing.id === patch.id ? patch : existing))
    : [...pruned, patch];

  const missionId = state.agent_runs.find((run) => run.id === patch.run_id)?.mission_id;
  const missions =
    patch.status === "pending" && missionId
      ? state.missions.map((mission) =>
          mission.id === missionId ? { ...mission, status: "waiting_approval" as const, updated_at: patch.updated_at } : mission,
        )
      : state.missions;
  return { ...state, patch_proposals, missions };
}
