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
};

export type GraphNodeKind = "repo" | "mission" | "file" | "worker" | "patch" | "verification" | "test" | "campaign";

export type WorkspaceGraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail: string;
  x: number;
  y: number;
  mission_id?: string;
  repository_id?: string;
};

export type WorkspaceGraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "owns" | "reads" | "runs" | "proposes" | "verifies" | "blocks" | "spawns" | "coordinates";
};
