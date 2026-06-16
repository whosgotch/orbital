import type { Mission, MissionLoopState, PatchStatus as WorkerPatchStatus, VerificationRun } from "./domain";
import type {
  MissionNodeStatus,
  WorkspaceGraphEdge,
  WorkspaceGraphNode,
  WorkspaceMission,
} from "./mockMission";

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

type WorkspaceViewFallback = WorkspaceView;

const maxWorkflowStep = 5;

export function workspaceViewFromMissionLoop(
  state: MissionLoopState,
  fallback: WorkspaceViewFallback,
): WorkspaceView {
  if (state.missions.length === 0) {
    return fallback;
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
    state.missions.map((mission) => {
      const run = state.agent_runs.filter((item) => item.mission_id === mission.id).at(-1);
      const patch = run ? state.patch_proposals.filter((proposal) => proposal.run_id === run.id).at(-1) : undefined;
      return [mission.id, patch?.diff ?? ""];
    }),
  );
  const verificationOutputByMission = Object.fromEntries(
    state.missions.map((mission) => [mission.id, latestVerification(state, mission.id)?.output ?? ""]),
  );
  const activityByMission = Object.fromEntries(
    state.missions.map((mission) => {
      const run = state.agent_runs.filter((item) => item.mission_id === mission.id).at(-1);
      const events = state.workflow_events.filter((event) => event.mission_id === mission.id || event.run_id === run?.id);
      return [mission.id, stationActivityFromEvents(events.map((event) => event.type))];
    }),
  );

  return {
    missions,
    graphNodes: graphNodesFromState(state, missions),
    graphEdges: graphEdgesFromState(missions),
    runtimeByMission,
    patchDiffByMission,
    verificationOutputByMission,
    activityByMission,
  };
}

function workspaceMissionFromState(state: MissionLoopState, mission: Mission, index: number): WorkspaceMission {
  const runs = state.agent_runs.filter((run) => run.mission_id === mission.id);
  const latestRun = runs.at(-1);
  const patch = latestRun
    ? state.patch_proposals.filter((proposal) => proposal.run_id === latestRun.id).at(-1)
    : undefined;
  const verification = latestVerification(state, mission.id);
  const events = state.workflow_events.filter((event) => event.mission_id === mission.id || event.run_id === latestRun?.id);

  return {
    id: mission.id,
    repository_id: mission.repository_id,
    title: mission.text,
    status: missionStatus(mission, patch?.status, verification),
    worker: latestRun?.worker_name ?? "unassigned",
    command: verification?.command ?? commandFromEvents(state, mission.id) ?? defaultVerificationCommand(state, mission),
    files: Array.from(new Set(events.map((event) => event.file_path).filter((path): path is string => Boolean(path)))),
    step: Math.min(Math.max(events.length - 1, -1), maxWorkflowStep),
    patch_status: patchStatus(patch?.status),
    verified: verification?.status === "passed",
    map_position: ["north", "east", "south", "west", "center"][index % 5] as WorkspaceMission["map_position"],
  };
}

function graphNodesFromState(state: MissionLoopState, missions: WorkspaceMission[]): WorkspaceGraphNode[] {
  const repoNodes = state.repositories.map((repository, index) => ({
    id: repository.id,
    kind: "repo" as const,
    label: repository.name,
    detail: "source zone",
    x: 10,
    y: 22 + index * 24,
    repository_id: repository.id,
  }));

  const missionNodes = missions.flatMap((mission, index) => {
    const rowY = 24 + index * 15;
    const hasRun = state.agent_runs.some((run) => run.mission_id === mission.id);
    const nodes: WorkspaceGraphNode[] = [
      {
        id: mission.id,
        kind: "mission",
        label: compactLabel(mission.title),
        detail: mission.status === "blocked" ? "blocked" : "mission order",
        x: 24,
        y: rowY,
        mission_id: mission.id,
        repository_id: mission.repository_id,
      },
    ];

    if (hasRun) {
      nodes.push({
        id: `${mission.id}_manager`,
        kind: "worker",
        label: "AI manager",
        detail: "dispatch",
        x: 36,
        y: rowY,
        mission_id: mission.id,
        repository_id: mission.repository_id,
      });
      nodes.push({
        id: `${mission.id}_architect`,
        kind: "worker",
        label: "Architect",
        detail: "system map",
        x: 49,
        y: rowY - 5,
        mission_id: mission.id,
        repository_id: mission.repository_id,
      });
      nodes.push({
        id: `${mission.id}_engineer`,
        kind: "worker",
        label: "Engineer",
        detail: "patch line",
        x: 61,
        y: rowY,
        mission_id: mission.id,
        repository_id: mission.repository_id,
      });
      nodes.push({
        id: `${mission.id}_qa`,
        kind: "worker",
        label: "QA",
        detail: "test gate",
        x: 83,
        y: rowY,
        mission_id: mission.id,
        repository_id: mission.repository_id,
      });
    }

    mission.files.slice(0, 2).forEach((file, fileIndex) => {
      nodes.push({
        id: `${mission.id}_file_${fileIndex}`,
        kind: "file",
        label: file,
        detail: "context",
        x: 49,
        y: rowY + 5 + fileIndex * 7,
        mission_id: mission.id,
        repository_id: mission.repository_id,
      });
    });

    nodes.push({
      id: `${mission.id}_patch`,
      kind: "patch",
      label: "Patch bay",
      detail: "approval gate",
      x: 72,
      y: rowY,
      mission_id: mission.id,
      repository_id: mission.repository_id,
    });
    nodes.push({
      id: `${mission.id}_verify`,
      kind: "verification",
      label: "Ship gate",
      detail: mission.command,
      x: 93,
      y: rowY,
      mission_id: mission.id,
      repository_id: mission.repository_id,
    });

    return nodes;
  });

  return [...repoNodes, ...missionNodes];
}

function graphEdgesFromState(missions: WorkspaceMission[]): WorkspaceGraphEdge[] {
  return missions.flatMap((mission) => {
    const managerID = `${mission.id}_manager`;
    const architectID = `${mission.id}_architect`;
    const engineerID = `${mission.id}_engineer`;
    const qaID = `${mission.id}_qa`;
    const patchID = `${mission.id}_patch`;
    const verifyID = `${mission.id}_verify`;
    const edges: WorkspaceGraphEdge[] = [
      { id: `${mission.repository_id}_${mission.id}`, from: mission.repository_id, to: mission.id, kind: "owns" },
    ];

    if (mission.step >= 0) {
      edges.push(
        { id: `${mission.id}_manager`, from: mission.id, to: managerID, kind: "runs" },
        { id: `${mission.id}_architect`, from: managerID, to: architectID, kind: "runs" },
        { id: `${mission.id}_engineer`, from: architectID, to: engineerID, kind: "runs" },
        { id: `${mission.id}_patch`, from: engineerID, to: patchID, kind: "proposes" },
        { id: `${mission.id}_qa`, from: patchID, to: qaID, kind: "runs" },
        { id: `${mission.id}_verify`, from: qaID, to: verifyID, kind: "verifies" },
      );
    } else {
      edges.push(
        { id: `${mission.id}_patch`, from: mission.id, to: patchID, kind: "proposes" },
        { id: `${mission.id}_verify`, from: patchID, to: verifyID, kind: "verifies" },
      );
    }

    mission.files.slice(0, 2).forEach((_, index) => {
      edges.push({
        id: `${mission.id}_file_${index}`,
        from: mission.step >= 0 ? architectID : mission.id,
        to: `${mission.id}_file_${index}`,
        kind: "reads",
      });
    });

    return edges;
  });
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

function stationActivityFromEvents(eventTypes: string[]) {
  if (eventTypes.length === 0) {
    return ["Mission order waiting in intake."];
  }

  return eventTypes.map((eventType) => {
    switch (eventType) {
      case "run_started":
        return "AI manager accepted the mission order.";
      case "repo_inspected":
        return "Architect mapped the repository floor.";
      case "file_read":
        return "Architect pulled source context onto the belt.";
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
      default:
        return "Factory station recorded new work.";
    }
  });
}

function compactLabel(title: string) {
  return title.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
}
