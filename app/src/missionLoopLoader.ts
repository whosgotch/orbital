import { invoke } from "@tauri-apps/api/core";
import type { MissionLoopState, RepoCommit } from "./domain";

const missionLoopFixturePath = "/workerMissionFixture.json";
export const demoRepoPath = "/private/tmp/orbital-demo-repo";

export async function loadMissionLoopState(repoPath = demoRepoPath): Promise<MissionLoopState> {
  if (isTauriRuntime()) {
    const state = await invoke<string>("load_worker_state", { repoPath });
    return JSON.parse(state) as MissionLoopState;
  }

  return loadRuntimeFixture();
}

export async function openMissionLoopRepository(repoPath: string): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("open_repository", { repoPath });
  return JSON.parse(state) as MissionLoopState;
}

export async function refreshMissionLoopState(): Promise<MissionLoopState> {
  if (isTauriRuntime()) {
    const state = await invoke<string>("refresh_demo_worker_loop");
    return JSON.parse(state) as MissionLoopState;
  }

  return loadRuntimeFixture();
}

export async function queueMissionLoopState(
  repoPath: string,
  missionText: string,
  campaignId?: string,
): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("queue_mission", { repoPath, missionText, campaignId });
  return JSON.parse(state) as MissionLoopState;
}

export async function updateMissionTextLoopState(
  repoPath: string,
  missionId: string,
  text: string,
): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("update_mission_text", { repoPath, missionId, text });
  return JSON.parse(state) as MissionLoopState;
}

export async function startAgentRunMissionLoopState(
  repoPath: string,
  missionId: string,
  workerName = "mock",
  command = "",
): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("start_agent_run", { repoPath, missionId, workerName, command });
  return JSON.parse(state) as MissionLoopState;
}

export async function sendAgentMessageLoopState(
  repoPath: string,
  missionId: string,
  text: string,
): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("send_agent_message", { repoPath, missionId, text });
  return JSON.parse(state) as MissionLoopState;
}

export async function deleteMissionLoopState(repoPath: string, missionId: string): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("delete_mission", { repoPath, missionId });
  return JSON.parse(state) as MissionLoopState;
}

export async function linkMissionsLoopState(
  repoPath: string,
  fromMissionId: string,
  toMissionId: string,
): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("link_missions", { repoPath, fromMissionId, toMissionId });
  return JSON.parse(state) as MissionLoopState;
}

export async function unlinkMissionsLoopState(
  repoPath: string,
  fromMissionId: string,
  toMissionId: string,
): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("unlink_missions", { repoPath, fromMissionId, toMissionId });
  return JSON.parse(state) as MissionLoopState;
}

export async function approvePatchMissionLoopState(repoPath: string, missionId: string): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("approve_patch", { repoPath, missionId });
  return JSON.parse(state) as MissionLoopState;
}

export async function rejectPatchMissionLoopState(repoPath: string, missionId: string): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("reject_patch", { repoPath, missionId });
  return JSON.parse(state) as MissionLoopState;
}

export async function verifyMissionLoopState(repoPath: string, missionId: string, command: string): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("verify_mission", { repoPath, missionId, command });
  return JSON.parse(state) as MissionLoopState;
}

export async function loadRepoHistory(repoPath: string): Promise<RepoCommit[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  const history = await invoke<string>("load_repo_history", { repoPath });
  return JSON.parse(history) as RepoCommit[];
}

export async function loadCommitDiff(repoPath: string, hash: string): Promise<string> {
  if (!isTauriRuntime()) {
    return "";
  }

  return invoke<string>("load_commit_diff", { repoPath, hash });
}

async function loadRuntimeFixture(): Promise<MissionLoopState> {
  const response = await fetch(missionLoopFixturePath);
  if (!response.ok) {
    throw new Error(`Failed to load mission loop state: ${response.status}`);
  }

  return (await response.json()) as MissionLoopState;
}

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
