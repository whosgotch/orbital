// Shared shapes of the workspace canvas: missions as the UI consumes them, and
// the graph nodes/edges the canvas renders.
import type { PatchStatus } from "../workspace/domain";

export type MissionNodeStatus = "draft" | "queued" | "running" | "review" | "approved" | "blocked" | "verified";

export type WorkspaceMission = {
  id: string;
  repository_id: string;
  // Short human-scannable display name — the subtask's own title when the
  // task was AI-extracted, else prompt (below) as a fallback.
  title: string;
  // The full instruction text the agent runs on (attachment lines stripped).
  prompt: string;
  status: MissionNodeStatus;
  worker: string;
  // The model that actually ran this mission, as the CLI resolved it.
  model?: string;
  command: string;
  files: string[];
  step: number;
  patch_status: Extract<PatchStatus, "pending" | "approved" | "rejected">;
  verified: boolean;
  map_position: "north" | "east" | "south" | "west" | "center";
  // Upstream missions whose patches must land before this one auto-starts.
  depends_on?: string[];
  // Absent kind reads as "task"; tool and research missions render as a
  // single card — their whole pipeline is the card itself.
  kind?: "task" | "tool" | "research";
};

// Every node is a step you operate, not a picture of state: a task you run and
// talk to, a tool you fire, a research whose findings you read and question.
// A mission is exactly one card — its agent, change set and verification are
// the panel behind that card, never cards of their own.
export type GraphNodeKind = "repo" | "task" | "campaign" | "tool" | "research";

// Per-kind payload that makes a node card operable and glanceable.
export type GraphNodeMeta = {
  draft?: boolean; // task: an unsaved canvas draft still being typed
  prompt?: string; // task: the full instruction
  worker?: string; // task: assigned worker label
  launchable?: boolean; // task: Run is available
  now?: string; // task: live "doing X" line
  live?: boolean; // task/tool: currently running
  files?: number; // task: touched file count in the proposed change set
  additions?: number;
  deletions?: number;
  patchState?: "none" | "pending" | "approved" | "rejected";
  command?: string; // tool: the command it runs
  verifyState?: "passed" | "failed"; // tool: how the command exited
  waitingFor?: string; // task: label of the upstream task it waits on
  attachments?: number; // task/research: pasted images riding in the prompt
  commitHash?: string; // task/tool/research: short hash of the landed commit
  branch?: string; // repo: current live branch
  contextTokens?: number; // task/research/agent: live context-window fill
  totalTokens?: number; // task/research/agent: tokens burned across the run
  durationMs?: number; // task/research/agent: wall-clock time the mission took
  model?: string; // task/research: model id that actually did the work
};

export type WorkspaceGraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail: string;
  mission_id?: string;
  repository_id?: string;
  meta?: GraphNodeMeta;
};

export type WorkspaceGraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "owns" | "coordinates" | "then";
};
