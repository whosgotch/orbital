import type { Mission, MissionLoopState, PatchStatus as WorkerPatchStatus, VerificationRun, WorkflowEvent } from "./domain";
import type {
  MissionNodeStatus,
  WorkspaceGraphEdge,
  WorkspaceGraphNode,
  WorkspaceMission,
} from "./graph";

export type PatchStatus = Extract<WorkerPatchStatus, "pending" | "approved" | "rejected">;

export type WorkspaceRuntime = {
  step: number;
  patchStatus: PatchStatus;
  verified: boolean;
  status: MissionNodeStatus;
};

export type WorkspaceRuntimeMap = Record<string, WorkspaceRuntime>;

export type WorkspaceView = {
  missions: WorkspaceMission[];
  graphNodes: WorkspaceGraphNode[];
  graphEdges: WorkspaceGraphEdge[];
  runtimeByMission: WorkspaceRuntimeMap;
  patchDiffByMission: Record<string, string>;
  verificationOutputByMission: Record<string, string>;
  activityByMission: Record<string, string[]>;
};

const emptyWorkspaceView: WorkspaceView = {
  missions: [],
  graphNodes: [],
  graphEdges: [],
  runtimeByMission: {},
  patchDiffByMission: {},
  verificationOutputByMission: {},
  activityByMission: {},
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
        verified: mission.verified,
        status: mission.status,
      },
    ]),
  ) as WorkspaceRuntimeMap;
  const patchDiffByMission = Object.fromEntries(
    state.missions.map((mission) => [mission.id, latestPatchForMission(state, mission.id)?.diff ?? ""]),
  );
  const verificationOutputByMission = Object.fromEntries(
    state.missions.map((mission) => [mission.id, latestVerification(state, mission.id)?.output ?? ""]),
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
    graphEdges: [...graphEdgesFromState(missions, state), ...campaignEdges(campaigns)],
    runtimeByMission,
    patchDiffByMission,
    verificationOutputByMission,
    activityByMission,
  };
}

function workspaceMissionFromState(state: MissionLoopState, mission: Mission, index: number): WorkspaceMission {
  const runs = state.agent_runs.filter((run) => run.mission_id === mission.id);
  const latestRun = runs.at(-1);
  const topLevelRun = runs.filter((run) => !run.parent_run_id).at(-1) ?? latestRun;
  const patch = latestPatchForMission(state, mission.id);
  const verification = latestVerification(state, mission.id);
  const events = state.workflow_events.filter((event) => event.mission_id === mission.id || event.run_id === latestRun?.id);

  return {
    id: mission.id,
    repository_id: mission.repository_id,
    title: mission.text,
    status: missionStatus(mission, patch?.status, verification),
    worker: topLevelRun?.worker_name ?? "unassigned",
    command: verification?.command ?? commandFromEvents(state, mission.id) ?? defaultVerificationCommand(state, mission),
    files: Array.from(new Set(events.map((event) => event.file_path).filter((path): path is string => Boolean(path)))),
    step: Math.max(events.length - 1, -1),
    patch_status: patchStatus(patch?.status),
    verified: verification?.status === "passed",
    map_position: ["north", "east", "south", "west", "center"][index % 5] as WorkspaceMission["map_position"],
    depends_on: mission.depends_on,
  };
}

function graphNodesFromState(state: MissionLoopState, missions: WorkspaceMission[]): WorkspaceGraphNode[] {
  const repoNodes = state.repositories.map((repository) => ({
    id: repository.id,
    kind: "repo" as const,
    label: repository.name,
    detail: "repository",
    repository_id: repository.id,
  }));

  // Every mission is a pipeline of operable steps: Task (run it) → Agent(s)
  // (talk to them) → Changes (gate them) → Verify (prove them). Agent and gate
  // nodes appear once their step is real; the Task node always exists — it's
  // the starting point.
  const missionNodes = missions.flatMap((mission) => {
    const topLevelRun = state.agent_runs.filter((run) => run.mission_id === mission.id && !run.parent_run_id).at(-1);
    const childRuns = topLevelRun
      ? state.agent_runs.filter((run) => run.parent_run_id === topLevelRun.id)
      : [];
    const hasPatch = Boolean(latestPatchForMission(state, mission.id));
    const hasVerify = Boolean(latestVerification(state, mission.id));
    const base = { mission_id: mission.id, repository_id: mission.repository_id };

    const nodes: WorkspaceGraphNode[] = [
      {
        id: mission.id,
        kind: "task",
        label: compactLabel(mission.title),
        detail: mission.status === "blocked" ? "blocked" : "task",
        meta: { prompt: mission.title },
        ...base,
      },
    ];

    if (topLevelRun) {
      nodes.push({
        id: `${mission.id}_manager`,
        kind: "agent",
        label: childRuns.length > 0 ? "AI manager" : roleLabel(topLevelRun.worker_name),
        detail: topLevelRun.worker_name,
        meta: { worker: topLevelRun.worker_name },
        ...base,
      });

      childRuns.forEach((child) => {
        nodes.push({
          id: child.id,
          kind: "agent",
          label: roleLabel(child.worker_name),
          detail: child.status,
          meta: { worker: child.worker_name },
          ...base,
        });
      });
    }

    if (hasPatch || hasVerify) {
      nodes.push({
        id: `${mission.id}_patch`,
        kind: "changes",
        label: "Changes",
        detail: "review gate",
        ...base,
      });
      nodes.push({
        id: `${mission.id}_verify`,
        kind: "verify",
        label: "Verify",
        detail: mission.command,
        meta: { command: mission.command },
        ...base,
      });
    }

    return nodes;
  });

  return [...repoNodes, ...missionNodes];
}

// Edges connect only the nodes that actually exist (see graphNodesFromState),
// so the graph never draws a line to a stage that hasn't happened yet.
function graphEdgesFromState(missions: WorkspaceMission[], state: MissionLoopState): WorkspaceGraphEdge[] {
  const present = new Set(missions.map((mission) => mission.id));
  return missions.flatMap((mission) => {
    const managerID = `${mission.id}_manager`;
    const patchID = `${mission.id}_patch`;
    const verifyID = `${mission.id}_verify`;
    const edges: WorkspaceGraphEdge[] = [
      { id: `${mission.repository_id}_${mission.id}`, from: mission.repository_id, to: mission.id, kind: "owns" },
    ];

    // Task chains: an upstream task's card feeds this task's card, so the
    // canvas shows the execution order the auto-dispatcher will follow.
    (mission.depends_on ?? []).forEach((upstreamId) => {
      if (present.has(upstreamId)) {
        edges.push({ id: `then_${upstreamId}_${mission.id}`, from: upstreamId, to: mission.id, kind: "then" });
      }
    });

    const topLevelRun = state.agent_runs.filter((run) => run.mission_id === mission.id && !run.parent_run_id).at(-1);
    const childRuns = topLevelRun
      ? state.agent_runs.filter((run) => run.parent_run_id === topLevelRun.id)
      : [];
    const hasGates = Boolean(latestPatchForMission(state, mission.id)) || Boolean(latestVerification(state, mission.id));

    // The node the change set hangs off: the child agents if any, else the
    // manager, else the task itself.
    const patchSources = childRuns.length > 0 ? childRuns.map((child) => child.id) : topLevelRun ? [managerID] : [mission.id];

    if (topLevelRun) {
      edges.push({ id: `${mission.id}_manager`, from: mission.id, to: managerID, kind: "runs" });
      childRuns.forEach((child) => {
        edges.push({ id: `${managerID}_${child.id}`, from: managerID, to: child.id, kind: "spawns" });
      });
    }

    if (hasGates) {
      patchSources.forEach((source) => {
        edges.push({ id: `${source}_patch`, from: source, to: patchID, kind: "proposes" });
      });
      edges.push({ id: `${mission.id}_verify`, from: patchID, to: verifyID, kind: "verifies" });
    }

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
    const landed = campaign.members.filter((m) => m.status === "verified" || m.status === "approved").length;
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

function missionStatus(
  mission: Mission,
  patchStatusValue: WorkerPatchStatus | undefined,
  verification: VerificationRun | undefined,
): MissionNodeStatus {
  if (verification?.status === "passed") {
    return "verified";
  }
  if (verification?.status === "failed" || mission.status === "failed" || mission.status === "rejected") {
    return "blocked";
  }
  if (patchStatusValue === "approved" || patchStatusValue === "applied" || mission.status === "approved" || mission.status === "applied") {
    return "approved";
  }
  if (patchStatusValue === "pending" || mission.status === "waiting_approval") {
    return "review";
  }
  if (mission.status === "running") {
    return "running";
  }
  return "draft";
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

function latestVerification(state: MissionLoopState, missionId: string) {
  return state.verification_runs.filter((verification) => verification.mission_id === missionId).at(-1);
}

function commandFromEvents(state: MissionLoopState, missionId: string) {
  return state.workflow_events.find((event) => event.mission_id === missionId && event.command)?.command;
}

function defaultVerificationCommand(state: MissionLoopState, mission: Mission) {
  const repository = state.repositories.find((item) => item.id === mission.repository_id);
  return repository?.verification_command || "true";
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
      case "verification_run":
        return "QA started the verification gate.";
      case "verification_passed":
        return "QA cleared the mission for shipping.";
      case "verification_failed":
        return "QA blocked the mission at the test gate.";
      case "run_completed":
        return "AI manager moved the mission to human review.";
      case "run_failed":
        return "AI manager marked the run failed.";
      case "run_cancelled":
        return "AI manager cancelled the run.";
      case "child_run_spawned":
        return event.message || "Manager dispatched a child agent.";
      case "child_run_completed":
        return "Child agent completed its assignment.";
      case "child_run_failed":
        return "Child agent failed. Manager assessing.";
      case "patches_merged":
        return event.message || "Manager merged patches from child agents.";
      default:
        return "Factory station recorded new work.";
    }
  });
}

function compactLabel(title: string) {
  return title.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
}

export function roleLabel(workerName: string) {
  switch (workerName) {
    case "claude-engineer":
      return "Engineer";
    case "claude-reviewer":
      return "Reviewer";
    case "claude-manager":
      return "AI manager";
    case "mock":
      return "Demo agent";
    case "local-command":
      return "Local agent";
    default:
      return workerName;
  }
}
