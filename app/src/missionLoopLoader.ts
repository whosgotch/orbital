import { invoke } from "@tauri-apps/api/core";
import type { MissionLoopState } from "./domain";

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

export async function queueMissionLoopState(repoPath: string, missionText: string): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("queue_mission", { repoPath, missionText });
  return JSON.parse(state) as MissionLoopState;
}

export async function startAgentRunMissionLoopState(repoPath: string, missionId: string): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>("start_agent_run", { repoPath, missionId });
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

async function loadRuntimeFixture(): Promise<MissionLoopState> {
  const response = await fetch(missionLoopFixturePath);
  if (!response.ok) {
    throw new Error(`Failed to load mission loop state: ${response.status}`);
  }

  return (await response.json()) as MissionLoopState;
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
