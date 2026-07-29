import { parseDiffFiles } from "../chat/statusModel";
import { statusFromRuntime, workerModeFromName, workerModeLabel, type WorkerMode } from "../workspace/missionUi";
import { compactLabel } from "../workspace/workspaceAdapter";
import type { CommitInfo, WorkspaceRuntimeMap } from "../workspace/workspaceAdapter";
import type { MissionNodeStatus, WorkspaceGraphEdge, WorkspaceGraphNode, WorkspaceMission } from "./graph";
import type { Repository } from "../workspace/domain";
import type { MissionUsage } from "../workspace/usage";

// Mirrors GraphMap's own GraphNode.
type GraphNode = WorkspaceGraphNode & { status?: MissionNodeStatus };

export type EnrichGraphNodesArgs = {
  workspaceGraphNodes: WorkspaceGraphNode[];
  workspaceMissions: WorkspaceMission[];
  runtimeByMission: WorkspaceRuntimeMap;
  workerModeByMission: Record<string, WorkerMode>;
  activityByMission: Record<string, string[]>;
  patchDiffByMission: Record<string, string>;
  commitByMission: Record<string, CommitInfo>;
  usageByMission: Record<string, MissionUsage>;
};

export function enrichGraphNodes({
  workspaceGraphNodes,
  workspaceMissions,
  runtimeByMission,
  workerModeByMission,
  activityByMission,
  patchDiffByMission,
  commitByMission,
  usageByMission,
}: EnrichGraphNodesArgs): GraphNode[] {
  // Fold a mission's token usage into the fields the node badge reads. Absent
  // usage leaves both undefined, so the node shows no badge rather than "0".
  const usageMeta = (missionId: string) => {
    const usage = usageByMission[missionId];
    if (!usage) return {};
    return {
      contextTokens: usage.contextTokens || undefined,
      totalTokens: usage.totalTokens || undefined,
      durationMs: usage.durationMs || undefined,
    };
  };
  // An upstream has landed when its patch was approved and applied or — for
  // tool steps, which have no patch gate — when its command finished clean.
  const upstreamLanded = (id: string) => {
    const upstream = runtimeByMission[id];
    return upstream?.patchStatus === "approved" || upstream?.status === "done";
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
        const live = runtime?.status === "running";
        // The task card carries its own change set: the counts it shows and the
        // Approve/Reject gate it offers are this mission's proposed patch.
        const diff = patchDiffByMission[missionId] ?? "";
        const files = parseDiffFiles(diff);
        return {
          ...node,
          status,
          meta: {
            ...node.meta,
            worker: workerModeLabel(workerModeByMission[missionId] ?? workerModeFromName(mission?.worker)),
            launchable,
            live,
            now: live ? activityByMission[missionId]?.at(-1) : undefined,
            waitingFor: firstUpstream ? compactLabel(firstUpstream.title) : undefined,
            commitHash: commitByMission[missionId]?.hash || undefined,
            files: files.length,
            additions: files.reduce((sum, file) => sum + file.added, 0),
            deletions: files.reduce((sum, file) => sum + file.removed, 0),
            patchState: diff ? runtime?.patchStatus ?? ("pending" as const) : ("none" as const),
            model: mission?.model,
            ...usageMeta(missionId),
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
            toolState: status === "done" ? ("passed" as const) : status === "blocked" ? ("failed" as const) : undefined,
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
            model: mission?.model,
            ...usageMeta(missionId),
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
