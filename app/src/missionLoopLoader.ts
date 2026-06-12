import { invoke } from "@tauri-apps/api/core";
import type { MissionLoopState } from "./domain";

const missionLoopFixturePath = "/workerMissionFixture.json";

export async function loadMissionLoopState(): Promise<MissionLoopState> {
  if (isTauriRuntime()) {
    const state = await invoke<string>("load_worker_state");
    return JSON.parse(state) as MissionLoopState;
  }

  return loadRuntimeFixture();
}

export async function refreshMissionLoopState(): Promise<MissionLoopState> {
  if (isTauriRuntime()) {
    const state = await invoke<string>("refresh_demo_worker_loop");
    return JSON.parse(state) as MissionLoopState;
  }

  return loadRuntimeFixture();
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
