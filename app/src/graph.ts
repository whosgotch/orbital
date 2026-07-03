// Shared shapes of the workspace canvas: missions as the UI consumes them, and
// the graph nodes/edges the canvas renders.
import type { PatchStatus } from "./domain";

export type MissionNodeStatus = "draft" | "queued" | "running" | "review" | "approved" | "blocked" | "verified";

export type WorkspaceMission = {
  id: string;
  repository_id: string;
  title: string;
  status: MissionNodeStatus;
  worker: string;
  command: string;
  files: string[];
  step: number;
  patch_status: Extract<PatchStatus, "pending" | "approved" | "rejected">;
  verified: boolean;
  map_position: "north" | "east" | "south" | "west" | "center";
  // Upstream missions whose patches must land before this one auto-starts.
  depends_on?: string[];
};

// Every node is a step you operate, not a picture of state: a task you run, an
// agent you talk to, a change set you gate, a verification you fire.
export type GraphNodeKind = "repo" | "task" | "agent" | "changes" | "verify" | "campaign";

// Per-kind payload that makes a node card operable and glanceable.
export type GraphNodeMeta = {
  draft?: boolean; // task: an unsaved canvas draft still being typed
  prompt?: string; // task: the full instruction
  worker?: string; // task/agent: assigned worker label
  launchable?: boolean; // task: Run is available
  now?: string; // agent: live "doing X" line
  live?: boolean; // agent: currently running
  files?: number; // changes: touched file count
  additions?: number;
  deletions?: number;
  patchState?: "none" | "pending" | "approved" | "rejected";
  command?: string; // verify: the verification command
  verifyState?: "idle" | "ready" | "passed" | "failed";
  waitingFor?: string; // task: label of the upstream task it waits on
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
  kind: "owns" | "reads" | "runs" | "proposes" | "verifies" | "blocks" | "spawns" | "coordinates" | "then";
};
