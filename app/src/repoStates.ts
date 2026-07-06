// Pure combinators over MissionLoopState for the multi-repo canvas: the app
// keeps one state slice per open repository and renders the union.
import type { MissionLoopState } from "./domain";

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

// Normalize a loaded state into one slice per repository, keyed by repo id. The
// worker returns a single repo per call, but the browser fixture bundles
// several — splitting lets each repo be added, updated, or closed on its own.
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

// Drop a mission and everything attached to it from a combined state. Mirrors
// the worker's DeleteMission cascade for the browser/demo path that has no
// backend to do it.
export function removeMissionFromState(state: MissionLoopState, missionId: string): MissionLoopState {
  const runIds = new Set(state.agent_runs.filter((run) => run.mission_id === missionId).map((run) => run.id));
  return {
    repositories: state.repositories,
    missions: state.missions.filter((mission) => mission.id !== missionId),
    agent_runs: state.agent_runs.filter((run) => run.mission_id !== missionId),
    workflow_events: state.workflow_events.filter(
      (event) => event.mission_id !== missionId && !(event.run_id != null && runIds.has(event.run_id)),
    ),
    patch_proposals: state.patch_proposals.filter((patch) => !runIds.has(patch.run_id)),
    verification_runs: state.verification_runs.filter((run) => run.mission_id !== missionId),
    chat_messages: state.chat_messages.filter((message) => message.mission_id !== missionId && !runIds.has(message.run_id)),
  };
}
