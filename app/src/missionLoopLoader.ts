import { invoke } from "@tauri-apps/api/core";
import type { MissionLoopState, RepoCommit } from "./domain";

const missionLoopFixturePath = "/workerMissionFixture.json";
export const demoRepoPath = "/private/tmp/orbital-demo-repo";

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

// Every worker command replies with the full mission-loop state as a JSON
// string. In the browser (no Tauri) this returns undefined and the caller
// keeps its local state instead.
async function invokeState(command: string, args: Record<string, unknown>): Promise<MissionLoopState | undefined> {
  if (!isTauriRuntime()) {
    return undefined;
  }

  const state = await invoke<string>(command, args);
  return JSON.parse(state) as MissionLoopState;
}

export async function loadMissionLoopState(repoPath = demoRepoPath): Promise<MissionLoopState> {
  return (await invokeState("load_worker_state", { repoPath })) ?? loadRuntimeFixture();
}

export async function refreshMissionLoopState(): Promise<MissionLoopState> {
  return (await invokeState("refresh_demo_worker_loop", {})) ?? loadRuntimeFixture();
}

export function openMissionLoopRepository(repoPath: string) {
  return invokeState("open_repository", { repoPath });
}

export function queueMissionLoopState(repoPath: string, missionText: string, campaignId?: string, toolCommand?: string) {
  return invokeState("queue_mission", { repoPath, missionText, campaignId, toolCommand });
}

export function updateMissionTextLoopState(repoPath: string, missionId: string, text: string) {
  return invokeState("update_mission_text", { repoPath, missionId, text });
}

export function startAgentRunMissionLoopState(repoPath: string, missionId: string, workerName = "mock", command = "", model = "") {
  return invokeState("start_agent_run", { repoPath, missionId, workerName, command, model });
}

export function sendAgentMessageLoopState(repoPath: string, missionId: string, text: string, model = "") {
  return invokeState("send_agent_message", { repoPath, missionId, text, model });
}

export function deleteMissionLoopState(repoPath: string, missionId: string) {
  return invokeState("delete_mission", { repoPath, missionId });
}

export function linkMissionsLoopState(repoPath: string, fromMissionId: string, toMissionId: string) {
  return invokeState("link_missions", { repoPath, fromMissionId, toMissionId });
}

export function unlinkMissionsLoopState(repoPath: string, fromMissionId: string, toMissionId: string) {
  return invokeState("unlink_missions", { repoPath, fromMissionId, toMissionId });
}

export function approvePatchMissionLoopState(repoPath: string, missionId: string) {
  return invokeState("approve_patch", { repoPath, missionId });
}

export function rejectPatchMissionLoopState(repoPath: string, missionId: string) {
  return invokeState("reject_patch", { repoPath, missionId });
}

export function verifyMissionLoopState(repoPath: string, missionId: string, command: string) {
  return invokeState("verify_mission", { repoPath, missionId, command });
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
