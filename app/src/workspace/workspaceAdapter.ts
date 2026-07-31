import { attachmentCount, stripAttachmentLines } from "../intake/attachments";
import { usageByMission, type MissionUsage } from "./usage";
import type { Mission, MissionLoopState, PatchStatus as WorkerPatchStatus, WorkflowEvent } from "./domain";
import type {
  MissionNodeStatus,
  WorkspaceGraphEdge,
  WorkspaceGraphNode,
  WorkspaceMission,
} from "../canvas/graph";

export type PatchStatus = Extract<WorkerPatchStatus, "pending" | "approved" | "rejected">;

export type WorkspaceRuntime = {
  step: number;
  patchStatus: PatchStatus;
  status: MissionNodeStatus;
  // Why this mission is blocked, in the worker's own words. Only set for
  // blocked missions — a node that stops must be able to say what stopped it.
  blockedReason?: string;
};

export type WorkspaceRuntimeMap = Record<string, WorkspaceRuntime>;

// hash "" means nothing has landed yet (draft, pending, or a re-apply that changed nothing).
export type CommitInfo = { hash: string; subject: string; branch: string };

export type WorkspaceView = {
  missions: WorkspaceMission[];
  graphNodes: WorkspaceGraphNode[];
  graphEdges: WorkspaceGraphEdge[];
  runtimeByMission: WorkspaceRuntimeMap;
  patchDiffByMission: Record<string, string>;
  commitByMission: Record<string, CommitInfo>;
  activityByMission: Record<string, string[]>;
  usageByMission: Record<string, MissionUsage>;
};

const emptyWorkspaceView: WorkspaceView = {
  missions: [],
  graphNodes: [],
  graphEdges: [],
  runtimeByMission: {},
  patchDiffByMission: {},
  commitByMission: {},
  activityByMission: {},
  usageByMission: {},
};

export function workspaceViewFromMissionLoop(state: MissionLoopState): WorkspaceView {
  if (state.missions.length === 0) {
    return emptyWorkspaceView;
  }

  const missions = state.missions.map((mission, index) => workspaceMissionFromState(state, mission, index));
  const runtimeByMission = Object.fromEntries(
    missions.map((mission) => [
      mission.id,
      {
        step: mission.step,
        patchStatus: mission.patch_status,
        status: mission.status,
        blockedReason: mission.status === "blocked" ? blockedReason(state, mission) : undefined,
      },
    ]),
  ) as WorkspaceRuntimeMap;
  const patchDiffByMission = Object.fromEntries(
    state.missions.map((mission) => [mission.id, latestPatchForMission(state, mission.id)?.diff ?? ""]),
  );
  const commitByMission = Object.fromEntries(
    state.missions.map((mission) => {
      const patch = latestPatchForMission(state, mission.id);
      return [
        mission.id,
        { hash: patch?.commit_hash ?? "", subject: patch?.commit_subject ?? "", branch: patch?.branch ?? "" },
      ];
    }),
  );
  const activityByMission = Object.fromEntries(
    state.missions.map((mission) => {
      const run = state.agent_runs.filter((item) => item.mission_id === mission.id).at(-1);
      const events = state.workflow_events.filter((event) => event.mission_id === mission.id || event.run_id === run?.id);
      return [mission.id, stationActivityFromEvents(events)];
    }),
  );

  const campaigns = campaignGroups(state, missions);

  return {
    missions,
    graphNodes: [...graphNodesFromState(state, missions), ...campaignNodes(campaigns)],
    graphEdges: [...graphEdgesFromState(missions), ...campaignEdges(campaigns)],
    runtimeByMission,
    patchDiffByMission,
    commitByMission,
    activityByMission,
    usageByMission: usageByMission(state.agent_runs),
  };
}

function workspaceMissionFromState(state: MissionLoopState, mission: Mission, index: number): WorkspaceMission {
  const runs = state.agent_runs.filter((run) => run.mission_id === mission.id);
  const latestRun = runs.at(-1);
  const topLevelRun = runs.filter((run) => !run.parent_run_id).at(-1) ?? latestRun;
  const patch = latestPatchForMission(state, mission.id);
  const events = state.workflow_events.filter((event) => event.mission_id === mission.id || event.run_id === latestRun?.id);

  // Attachment paths are agent plumbing — everything the UI shows strips them.
  const prompt = stripAttachmentLines(mission.text);
  return {
    id: mission.id,
    repository_id: mission.repository_id,
    // An extracted task's own short title, else the full prompt.
    title: mission.title?.trim() || prompt,
    prompt,
    status: missionStatus(mission, patch?.status),
    worker: topLevelRun?.worker_name ?? "unassigned",
    // What ran, if it has; otherwise the choice made when the task was created.
    model: topLevelRun?.model || mission.model,
    command: mission.kind === "tool" ? mission.tool_command ?? "" : "",
    files: Array.from(new Set(events.map((event) => event.file_path).filter((path): path is string => Boolean(path)))),
    step: Math.max(events.length - 1, -1),
    patch_status: patchStatus(patch?.status),
    map_position: ["north", "east", "south", "west", "center"][index % 5] as WorkspaceMission["map_position"],
    depends_on: mission.depends_on,
    // Only "tool" changes how a node behaves; every other kind — including the
    // retired "research" still sitting in older state files — reads as a task.
    kind: mission.kind === "tool" ? "tool" : undefined,
  };
}

function graphNodesFromState(state: MissionLoopState, missions: WorkspaceMission[]): WorkspaceGraphNode[] {
  const repoNodes = state.repositories.map((repository) => ({
    id: repository.id,
    kind: "repo" as const,
    label: repository.name,
    detail: "repository",
    repository_id: repository.id,
    meta: repository.branch ? { branch: repository.branch } : undefined,
  }));

  // One card per mission, whatever its kind: the mission node IS the mission.
  // Its run — the agent's chat, the change set — lives in that node's panel,
  // never as extra cards the canvas has to place.
  // Pasted-image counts come from the raw mission text; the titles the nodes wear have the attachment lines stripped already.
  const attachmentsByMission = new Map(state.missions.map((mission) => [mission.id, attachmentCount(mission.text)]));

  const missionNodes = missions.map((mission): WorkspaceGraphNode => {
    const attachments = attachmentsByMission.get(mission.id) || undefined;
    const base = { mission_id: mission.id, repository_id: mission.repository_id };

    if (mission.kind === "tool") {
      return {
        id: mission.id,
        kind: "tool" as const,
        label: compactLabel(mission.title),
        detail: mission.command,
        meta: { prompt: mission.prompt, command: mission.command, attachments },
        ...base,
      };
    }

    return {
      id: mission.id,
      kind: "task" as const,
      label: compactLabel(mission.title),
      detail: mission.status === "blocked" ? "blocked" : "task",
      meta: { prompt: mission.prompt, attachments },
      ...base,
    };
  });

  return [...repoNodes, ...missionNodes];
}

// One card per mission means the only edges are ownership (repo → chain head)
// and the chains the user draws between missions.
function graphEdgesFromState(missions: WorkspaceMission[]): WorkspaceGraphEdge[] {
  const present = new Set(missions.map((mission) => mission.id));
  return missions.flatMap((mission) => {
    const edges: WorkspaceGraphEdge[] = [];

    // Task chains: an upstream task's card feeds this task's card, so the
    // canvas shows the execution order the auto-dispatcher will follow. A
    // chained task hangs off its upstream, not the repo — only chain heads
    // (tasks with no upstream on the canvas) connect to the repo node.
    const upstreams = (mission.depends_on ?? []).filter((upstreamId) => present.has(upstreamId));
    if (upstreams.length === 0) {
      edges.push({ id: `${mission.repository_id}_${mission.id}`, from: mission.repository_id, to: mission.id, kind: "owns" });
    }
    upstreams.forEach((upstreamId) => {
      edges.push({ id: `then_${upstreamId}_${mission.id}`, from: upstreamId, to: mission.id, kind: "then" });
    });

    return edges;
  });
}

type CampaignGroup = {
  id: string;
  text: string;
  members: WorkspaceMission[];
};

// A campaign is the per-repo fan-out of one coordinated change. Each repo keeps
// its own state, so membership is reconstructed by grouping missions that share
// a campaign_id across the combined workspace. Singletons are ignored — a
// campaign only reads as one when it spans more than a single repo.
function campaignGroups(state: MissionLoopState, missions: WorkspaceMission[]): CampaignGroup[] {
  const campaignByMission = new Map(state.missions.map((mission) => [mission.id, mission.campaign_id]));
  const groups = new Map<string, CampaignGroup>();
  missions.forEach((mission) => {
    const campaignId = campaignByMission.get(mission.id);
    if (!campaignId) return;
    if (!groups.has(campaignId)) groups.set(campaignId, { id: campaignId, text: mission.title, members: [] });
    groups.get(campaignId)!.members.push(mission);
  });
  return Array.from(groups.values()).filter((group) => group.members.length > 1);
}

function campaignNodes(campaigns: CampaignGroup[]): WorkspaceGraphNode[] {
  return campaigns.map((campaign) => {
    const landed = campaign.members.filter((m) => m.status === "done").length;
    return {
      id: `campaign:${campaign.id}`,
      kind: "campaign" as const,
      label: compactLabel(campaign.text),
      detail: `${campaign.members.length} repos · ${landed}/${campaign.members.length} landed`,
      // Own synthetic lane so the swimlane layout gives it a labeled band that
      // sits apart from the repo lanes it fans out into.
      mission_id: `campaign:${campaign.id}`,
    };
  });
}

function campaignEdges(campaigns: CampaignGroup[]): WorkspaceGraphEdge[] {
  return campaigns.flatMap((campaign) =>
    campaign.members.map((mission) => ({
      id: `campaign_${campaign.id}_${mission.id}`,
      from: `campaign:${campaign.id}`,
      to: mission.id,
      kind: "coordinates" as const,
    })),
  );
}

function missionStatus(mission: Mission, patchStatusValue: WorkerPatchStatus | undefined): MissionNodeStatus {
  // Approve + apply is the last step, so an applied patch is a finished task.
  // "verified" is the worker's terminal status for missions with no patch to
  // approve: a tool whose command exited clean.
  if (patchStatusValue === "approved" || patchStatusValue === "applied") {
    return "done";
  }
  if (mission.status === "verified" || mission.status === "approved" || mission.status === "applied") {
    return "done";
  }
  if (mission.status === "failed" || mission.status === "rejected") {
    return "blocked";
  }
  if (patchStatusValue === "pending" || mission.status === "waiting_approval") {
    return "review";
  }
  if (mission.status === "running") {
    return "running";
  }
  return "draft";
}

// The reason a blocked mission stopped, most specific first: the run's own
// error, then the failure event that ended it, then the human gate. Blocked
// with nothing recorded still says something — silence is what made blocked
// nodes unreadable in the first place.
function blockedReason(state: MissionLoopState, mission: WorkspaceMission): string {
  const runs = state.agent_runs.filter((run) => run.mission_id === mission.id);
  const failedRun = runs.filter((run) => run.error?.trim()).at(-1);
  if (failedRun?.error) {
    return failedRun.error.trim();
  }

  const runIds = new Set(runs.map((run) => run.id));
  const failureEvent = state.workflow_events
    .filter(
      (event) =>
        (event.type === "run_failed" || event.type === "child_run_failed") &&
        (event.mission_id === mission.id || (event.run_id != null && runIds.has(event.run_id))),
    )
    .at(-1);
  if (failureEvent?.message.trim()) {
    return failureEvent.message.trim();
  }

  if (mission.patch_status === "rejected") {
    return "You rejected this patch — revise the task in chat and run it again.";
  }

  return "The run failed without reporting a reason.";
}

function patchStatus(status: WorkerPatchStatus | undefined): PatchStatus {
  if (status === "approved" || status === "applied") {
    return "approved";
  }
  if (status === "rejected") {
    return "rejected";
  }
  return "pending";
}

// A mission can span several runs (an AI manager spawns child agents). Find the
// latest patch from the most recent run that produced one, so the CEO gate shows
// and approves the same patch the worker `approve` command resolves.
function latestPatchForMission(state: MissionLoopState, missionId: string) {
  const runs = state.agent_runs.filter((run) => run.mission_id === missionId);
  for (let index = runs.length - 1; index >= 0; index--) {
    const patch = state.patch_proposals.filter((proposal) => proposal.run_id === runs[index].id).at(-1);
    if (patch) {
      return patch;
    }
  }
  return undefined;
}

function stationActivityFromEvents(events: WorkflowEvent[]) {
  if (events.length === 0) {
    return ["Mission order waiting in intake."];
  }

  return events.map((event) => {
    switch (event.type) {
      case "run_started":
        return "AI manager accepted the mission order.";
      case "repo_inspected":
        return "Architect mapped the repository floor.";
      case "file_read":
        return "Architect pulled source context onto the belt.";
      case "command_executed":
        // Preserve the agent's own narration (Claude's live actions, the
        // manager's plan, local-command output) so the hydrated feed keeps the
        // detail the live stream showed.
        return event.message || "Work executed on the floor.";
      case "patch_proposed":
        return "Engineer delivered a patch to the approval bay.";
      case "patch_approved":
        return "Human CEO approved the patch for application.";
      case "patch_rejected":
        return "Human CEO rejected the patch and stopped the line.";
      case "patch_applied":
        return "Engineer applied the approved patch.";
      case "run_completed":
        return "AI manager moved the mission to human review.";
      case "run_failed":
        // The worker writes the actual cause here — never replace it with prose.
        return event.message || "AI manager marked the run failed.";
      case "run_cancelled":
        return "AI manager cancelled the run.";
      case "agent_thought":
      case "agent_action":
        // The agent's own narration and tool calls — the live "now" line on the
        // canvas shows the latest of these verbatim.
        return event.message || "Agent working.";
      case "child_run_spawned":
        return event.message || "Manager dispatched a child agent.";
      case "child_run_completed":
        return "Child agent completed its assignment.";
      case "child_run_failed":
        return event.message || "Child agent failed. Manager assessing.";
      case "patches_merged":
        return event.message || "Manager merged patches from child agents.";
      default:
        return "Factory station recorded new work.";
    }
  });
}

export function compactLabel(title: string) {
  const words = title.split(/\s+/).filter(Boolean);
  const label = words.slice(0, 6).join(" ");
  return words.length > 6 ? `${label}…` : label;
}

// A selected node is a valid follow-up target only when it's a mission that
// can hand off a summary/diff at run time — a task card. Repo, tool and
// campaign nodes never qualify.
export function followUpTargetFor(
  node: WorkspaceGraphNode | undefined,
  missions: WorkspaceMission[],
): { id: string; title: string } | undefined {
  if (!node || node.kind !== "task") return undefined;
  const mission = missions.find((item) => item.id === node.mission_id);
  if (!mission) return undefined;
  return { id: mission.id, title: compactLabel(mission.title) };
}

export function roleLabel(workerName: string) {
  switch (workerName) {
    case "claude-engineer":
      return "Engineer";
    case "claude-manager":
      return "AI manager";
    case "local-command":
      return "Local agent";
    default:
      return workerName;
  }
}
