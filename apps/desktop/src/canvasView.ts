// Pure builders for what the canvas renders: enriching the workspace graph
// nodes with live runtime data, and layering the in-progress draft task card
// on top. Kept free of component state — everything comes in as a parameter —
// so App.tsx's memos stay one-line calls into here.
import { parseDiffFiles } from "./agentStatus";
import { statusFromRuntime, workerModeFromName, workerModeLabel, type WorkerMode } from "./missionUi";
import { compactLabel } from "./workspaceAdapter";
import type { CommitInfo, WorkspaceRuntimeMap } from "./workspaceAdapter";
import type { MissionNodeStatus, WorkspaceGraphEdge, WorkspaceGraphNode, WorkspaceMission } from "./graph";
import type { Repository } from "./domain";

// Mirrors GraphMap's own GraphNode: the workspace node plus the derived
// status dot/border color it renders with.
type GraphNode = WorkspaceGraphNode & { status?: MissionNodeStatus };

export type EnrichGraphNodesArgs = {
  workspaceGraphNodes: WorkspaceGraphNode[];
  workspaceMissions: WorkspaceMission[];
  runtimeByMission: WorkspaceRuntimeMap;
  workerModeByMission: Record<string, WorkerMode>;
  activityByMission: Record<string, string[]>;
  patchDiffByMission: Record<string, string>;
  verificationOutputByMission: Record<string, string>;
  verificationCommandByMission: Record<string, string>;
  commitByMission: Record<string, CommitInfo>;
};

// Enrich each pipeline card with the live data its step operates on: the
// task's worker + launchability, the agent's "now" line, the change set's
// stats and gate state, the verify command and result.
export function enrichGraphNodes({
  workspaceGraphNodes,
  workspaceMissions,
  runtimeByMission,
  workerModeByMission,
  activityByMission,
  patchDiffByMission,
  verificationOutputByMission,
  verificationCommandByMission,
  commitByMission,
}: EnrichGraphNodesArgs): GraphNode[] {
  // An upstream has landed when its patch was approved or — for tool steps,
  // which have no patch gate — when its command finished as verified.
  const upstreamLanded = (id: string) => {
    const upstream = runtimeByMission[id];
    return upstream?.patchStatus === "approved" || upstream?.status === "approved" || upstream?.status === "verified";
  };

  return workspaceGraphNodes.map((node) => {
    const missionId = node.mission_id;
    const runtime = missionId ? runtimeByMission[missionId] : undefined;
    const status = runtime ? statusFromRuntime(runtime) : undefined;
    if (!missionId) return { ...node, status };

    switch (node.kind) {
      case "task": {
        const mission = workspaceMissions.find((m) => m.id === missionId);
        // A chained task waits until every upstream patch has landed; while
        // waiting it can't be launched by hand either — the chain owns it.
        const pendingUpstreams = (mission?.depends_on ?? []).filter((id) => !upstreamLanded(id));
        const firstUpstream = workspaceMissions.find((m) => m.id === pendingUpstreams[0]);
        const launchable =
          (!runtime || runtime.status === "queued" || runtime.status === "draft") && pendingUpstreams.length === 0;
        return {
          ...node,
          status,
          meta: {
            ...node.meta,
            worker: workerModeLabel(workerModeByMission[missionId] ?? workerModeFromName(mission?.worker)),
            launchable,
            waitingFor: firstUpstream ? compactLabel(firstUpstream.title) : undefined,
            commitHash: commitByMission[missionId]?.hash || undefined,
          },
        };
      }
      case "tool": {
        const mission = workspaceMissions.find((m) => m.id === missionId);
        const pendingUpstreams = (mission?.depends_on ?? []).filter((id) => !upstreamLanded(id));
        const firstUpstream = workspaceMissions.find((m) => m.id === pendingUpstreams[0]);
        // "blocked" here means the command failed — offering Run again is
        // the re-run affordance (tools have no reject path to collide with).
        const launchable =
          (!runtime || runtime.status === "queued" || runtime.status === "draft" || runtime.status === "blocked") &&
          pendingUpstreams.length === 0;
        return {
          ...node,
          status,
          meta: {
            ...node.meta,
            launchable,
            live: runtime?.status === "running",
            waitingFor: firstUpstream ? compactLabel(firstUpstream.title) : undefined,
            verifyState: status === "verified" ? ("passed" as const) : status === "blocked" ? ("failed" as const) : undefined,
            commitHash: commitByMission[missionId]?.hash || undefined,
          },
        };
      }
      case "research": {
        const mission = workspaceMissions.find((m) => m.id === missionId);
        const pendingUpstreams = (mission?.depends_on ?? []).filter((id) => !upstreamLanded(id));
        const firstUpstream = workspaceMissions.find((m) => m.id === pendingUpstreams[0]);
        const launchable =
          (!runtime || runtime.status === "queued" || runtime.status === "draft") && pendingUpstreams.length === 0;
        return {
          ...node,
          status,
          meta: {
            ...node.meta,
            launchable,
            waitingFor: firstUpstream ? compactLabel(firstUpstream.title) : undefined,
            commitHash: commitByMission[missionId]?.hash || undefined,
          },
        };
      }
      case "agent": {
        const live = runtime?.status === "running";
        return {
          ...node,
          status,
          meta: { ...node.meta, live, now: live ? activityByMission[missionId]?.at(-1) : undefined },
        };
      }
      case "changes": {
        const diff = patchDiffByMission[missionId] ?? "";
        const files = parseDiffFiles(diff);
        return {
          ...node,
          status,
          meta: {
            ...node.meta,
            files: files.length,
            additions: files.reduce((sum, file) => sum + file.added, 0),
            deletions: files.reduce((sum, file) => sum + file.removed, 0),
            patchState: diff ? runtime?.patchStatus ?? ("pending" as const) : ("none" as const),
          },
        };
      }
      case "verify": {
        const output = verificationOutputByMission[missionId] ?? "";
        const verifyState = runtime?.verified
          ? ("passed" as const)
          : output
            ? ("failed" as const)
            : runtime?.patchStatus === "approved"
              ? ("ready" as const)
              : ("idle" as const);
        return {
          ...node,
          status,
          meta: {
            ...node.meta,
            command: verificationCommandByMission[missionId] ?? node.meta?.command,
            verifyState,
          },
        };
      }
      default:
        return { ...node, status };
    }
  });
}

// While "+ Task" is open, the canvas shows one extra draft card wired to its
// repo, in its own lane — authored in place, committed via Queue/Run.
export function draftTaskNode(draftNodeId: string, draftRepositoryId: string | undefined): WorkspaceGraphNode {
  return {
    id: draftNodeId,
    kind: "task" as const,
    label: "New task",
    detail: "task",
    mission_id: draftNodeId,
    repository_id: draftRepositoryId,
    meta: { draft: true },
  };
}

export function buildCanvasNodes(
  graphNodes: GraphNode[],
  draftingTask: boolean,
  draftNodeId: string,
  draftRepositoryId: string | undefined,
): GraphNode[] {
  if (!draftingTask) return graphNodes;
  return [...graphNodes, draftTaskNode(draftNodeId, draftRepositoryId)];
}

export function buildCanvasEdges(
  graphEdges: WorkspaceGraphEdge[],
  draftingTask: boolean,
  draftNodeId: string,
  draftRepository: Repository | undefined,
): WorkspaceGraphEdge[] {
  if (!draftingTask || !draftRepository) return graphEdges;
  return [...graphEdges, { id: "edge_task_draft", from: draftRepository.id, to: draftNodeId, kind: "owns" as const }];
}
