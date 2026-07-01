export type Repository = {
  id: string;
  path: string;
  name: string;
  branch: string;
  verification_command?: string;
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

export type Mission = {
  id: string;
  repository_id: string;
  text: string;
  status: MissionStatus;
  created_at: string;
  updated_at: string;
  parent_mission_id?: string;
  campaign_id?: string;
};

export type AgentRunStatus = "queued" | "running" | "waiting_for_children" | "aggregating" | "completed" | "failed" | "cancelled";

export type AgentRun = {
  id: string;
  mission_id: string;
  worker_name: string;
  status: AgentRunStatus;
  started_at: string;
  completed_at?: string;
  error?: string;
  parent_run_id?: string;
  child_run_ids?: string[];
  session_id?: string;
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
  | "verification_run"
  | "verification_passed"
  | "verification_failed"
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
};

export type VerificationStatus = "queued" | "running" | "passed" | "failed";

export type VerificationRun = {
  id: string;
  mission_id: string;
  repository_id: string;
  command: string;
  status: VerificationStatus;
  exit_code?: number;
  output: string;
  started_at: string;
  completed_at?: string;
};

export type MissionLoopState = {
  repositories: Repository[];
  missions: Mission[];
  agent_runs: AgentRun[];
  workflow_events: WorkflowEvent[];
  patch_proposals: PatchProposal[];
  verification_runs: VerificationRun[];
  chat_messages: ChatMessage[];
};
