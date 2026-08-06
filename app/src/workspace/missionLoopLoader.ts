import { invoke } from "@tauri-apps/api/core";
import type { GitSync, MissionLoopState, RepoCommit } from "./domain";

async function invokeState(command: string, args: Record<string, unknown>): Promise<MissionLoopState> {
  const state = await invoke<string>(command, args);
  return JSON.parse(state) as MissionLoopState;
}

export function openMissionLoopRepository(repoPath: string) {
  return invokeState("open_repository", { repoPath });
}

export function queueMissionLoopState(
  repoPath: string,
  missionText: string,
  campaignId?: string,
  toolCommand?: string,
  // The model this mission runs on, chosen at creation and persisted with it so
  // a reload can't swap it for whatever the global picker happens to say.
  model?: string,
) {
  return invokeState("queue_mission", { repoPath, missionText, campaignId, toolCommand, model });
}

export function updateMissionTextLoopState(repoPath: string, missionId: string, text: string) {
  return invokeState("update_mission_text", { repoPath, missionId, text });
}

export function startAgentRunMissionLoopState(repoPath: string, missionId: string, workerName: string, command = "", model = "", effort = "") {
  return invokeState("start_agent_run", { repoPath, missionId, workerName, command, model, effort });
}

export function sendAgentMessageLoopState(repoPath: string, missionId: string, text: string, model = "", effort = "") {
  return invokeState("send_agent_message", { repoPath, missionId, text, model, effort });
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

// message is the commit message the user edited in the gate; "" keeps the
// engineer's suggested subject.
export function approvePatchMissionLoopState(repoPath: string, missionId: string, message = "") {
  return invokeState("approve_patch", { repoPath, missionId, message });
}

export function amendCommitMissionLoopState(repoPath: string, missionId: string, message: string) {
  return invokeState("amend_commit", { repoPath, missionId, message });
}

export function rejectPatchMissionLoopState(repoPath: string, missionId: string) {
  return invokeState("reject_patch", { repoPath, missionId });
}

export async function loadGitSync(repoPath: string): Promise<GitSync> {
  return JSON.parse(await invoke<string>("git_sync", { repoPath })) as GitSync;
}

export async function pushRepo(repoPath: string): Promise<GitSync> {
  return JSON.parse(await invoke<string>("push_repo", { repoPath })) as GitSync;
}

// Local branches, most recently committed first.
export async function loadBranches(repoPath: string): Promise<string[]> {
  return JSON.parse(await invoke<string>("list_branches", { repoPath })) as string[];
}

export async function switchBranch(repoPath: string, branch: string, create: boolean): Promise<GitSync> {
  return JSON.parse(await invoke<string>("switch_branch", { repoPath, branch, create })) as GitSync;
}

export async function loadRepoHistory(repoPath: string): Promise<RepoCommit[]> {
  const history = await invoke<string>("load_repo_history", { repoPath });
  return JSON.parse(history) as RepoCommit[];
}

export function loadCommitDiff(repoPath: string, hash: string): Promise<string> {
  return invoke<string>("load_commit_diff", { repoPath, hash });
}

// The model catalog the installed claude CLI carries, plus the model and
// thinking level the user already configured in Claude Code.
export type ModelCatalogPayload = {
  models: { id: string; display_name: string; effort_levels: string[]; default_effort?: string }[];
  default_model?: string;
  default_effort?: string;
};

export async function loadModels(): Promise<ModelCatalogPayload> {
  const catalog = await invoke<string>("list_models");
  return JSON.parse(catalog) as ModelCatalogPayload;
}
