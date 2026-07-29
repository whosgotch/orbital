import { invoke } from "@tauri-apps/api/core";
import type { MissionLoopState, RepoCommit } from "./domain";

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
  research?: boolean,
) {
  return invokeState("queue_mission", { repoPath, missionText, campaignId, toolCommand, research });
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

export function approvePatchMissionLoopState(repoPath: string, missionId: string) {
  return invokeState("approve_patch", { repoPath, missionId });
}

export function rejectPatchMissionLoopState(repoPath: string, missionId: string) {
  return invokeState("reject_patch", { repoPath, missionId });
}

// Turn a research mission's findings document into draft tasks chained after
// it, so their prompts stay concise and the findings still flow down via the
// ordinary upstream hand-off.
export function extractTasksLoopState(repoPath: string, missionId: string, model = "") {
  return invokeState("extract_tasks", { repoPath, missionId, model });
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
