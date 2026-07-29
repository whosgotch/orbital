export type Repository = {
  id: string;
  path: string;
  name: string;
  branch: string;
  created_at: string;
};

export type MissionStatus =
  | "draft"
  | "running"
  | "waiting_approval"
  | "approved"
  | "applied"
  | "rejected"
  | "verified"
  | "failed";

export type MissionKind = "task" | "tool" | "research";

export type Mission = {
  id: string;
  repository_id: string;
  // Short, human-scannable display name (set by AI task extraction); absent
  // for hand-typed missions, where the frontend derives a label from text.
  title?: string;
  text: string;
  status: MissionStatus;
  created_at: string;
  updated_at: string;
  parent_mission_id?: string;
  campaign_id?: string;
  depends_on?: string[];
  // Absent kind reads as "task"; a tool mission runs tool_command instead of
  // an AI agent and lands as verified/failed on the command's exit code
  // ("verified" is the worker's terminal status for a mission with no patch).
  kind?: MissionKind;
  // A research mission's findings — the full current document, rewritten by
  // the researcher on every chat turn.
  document?: string;
  tool_command?: string;
};

export type AgentRunStatus = "queued" | "running" | "waiting_for_children" | "aggregating" | "completed" | "failed" | "cancelled";

export type AgentRun = {
  id: string;
  mission_id: string;
  worker_name: string;
  status: AgentRunStatus;
  started_at: string;
  completed_at?: string;
  // Wall-clock span from started_at to completed_at, in milliseconds; absent
  // (or 0) while the run is still going. Mirrors the worker's duration_ms.
  duration_ms?: number;
  error?: string;
  parent_run_id?: string;
  child_run_ids?: string[];
  session_id?: string;
  usage?: RunUsage;
  // The model that actually did the work, as the CLI resolved it — absent until
  // the run's first turn reports one.
  model?: string;
};

// Token accounting for a run. context_tokens is the live context-window fill
// (the last turn's full input, cache included); the rest accumulate across every
// turn of the run's session. Mirrors the worker's domain.RunUsage json tags.
export type RunUsage = {
  context_tokens: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd?: number;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  mission_id: string;
  run_id: string;
  role: ChatRole;
  text: string;
  created_at: string;
};

export type WorkflowEventType =
  | "run_started"
  | "repo_inspected"
  | "file_read"
  | "command_executed"
  | "agent_thought"
  | "agent_action"
  | "patch_proposed"
  | "patch_approved"
  | "patch_rejected"
  | "patch_applied"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "child_run_spawned"
  | "child_run_completed"
  | "child_run_failed"
  | "patches_merged";

export type WorkflowEvent = {
  id: string;
  mission_id?: string;
  run_id?: string;
  type: WorkflowEventType;
  message: string;
  file_path?: string;
  command?: string;
  created_at: string;
};

export type PatchStatus = "pending" | "approved" | "rejected" | "applied";

export type PatchProposal = {
  id: string;
  run_id: string;
  status: PatchStatus;
  diff: string;
  created_at: string;
  updated_at: string;
  commit_hash?: string;
  commit_subject?: string;
  branch?: string;
};

export type RepoCommit = {
  hash: string;
  short_hash: string;
  author: string;
  date: string;
  subject: string;
};

export type MissionLoopState = {
  repositories: Repository[];
  missions: Mission[];
  agent_runs: AgentRun[];
  workflow_events: WorkflowEvent[];
  patch_proposals: PatchProposal[];
  chat_messages: ChatMessage[];
};
