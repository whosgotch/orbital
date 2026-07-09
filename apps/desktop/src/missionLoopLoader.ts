import { invoke } from "@tauri-apps/api/core";
import type { MissionLoopState, PlanFormat, RepoCommit } from "./domain";

export const demoRepoPath = "/private/tmp/orbital-demo-repo";

// Every worker command replies with the full mission-loop state as a JSON
// string.
async function invokeState(command: string, args: Record<string, unknown>): Promise<MissionLoopState> {
  const state = await invoke<string>(command, args);
  return JSON.parse(state) as MissionLoopState;
}

export function loadMissionLoopState(repoPath = demoRepoPath): Promise<MissionLoopState> {
  return invokeState("load_worker_state", { repoPath });
}

export function refreshMissionLoopState(): Promise<MissionLoopState> {
  return invokeState("refresh_demo_worker_loop", {});
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

// Ask the AI to break a draft task into sub-task nodes. Returns the refreshed
// state: split → the umbrella node is replaced by its sub-tasks; atomic →
// unchanged.
export function decomposeMissionLoopState(repoPath: string, missionId: string, model = "") {
  return invokeState("decompose_mission", { repoPath, missionId, model });
}

// Plan work on a repo: the AI reads the code, writes a plan in `format`, and
// fans out draft task nodes. Returns the refreshed state with the new plan.
export function planRepoLoopState(repoPath: string, goal: string, format: PlanFormat = "md", model = "") {
  return invokeState("plan_repo", { repoPath, goal, format, model });
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

export type ClaudeModel = { id: string; display_name: string };

// All models currently available in the provider (live list when an API key is
// configured, current catalog otherwise).
export async function listClaudeModels(): Promise<ClaudeModel[]> {
  const models = await invoke<string>("list_models");
  return JSON.parse(models) as ClaudeModel[];
}

export async function loadRepoHistory(repoPath: string): Promise<RepoCommit[]> {
  const history = await invoke<string>("load_repo_history", { repoPath });
  return JSON.parse(history) as RepoCommit[];
}

export function loadCommitDiff(repoPath: string, hash: string): Promise<string> {
  return invoke<string>("load_commit_diff", { repoPath, hash });
}
