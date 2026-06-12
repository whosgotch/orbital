import { useMemo, useState } from "react";
import {
  Check,
  CircleDot,
  Network,
  Play,
  RadioTower,
  Rocket,
  ShieldCheck,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { GraphMap } from "./components/GraphMap";
import {
  mockGraphEdges,
  mockGraphNodes,
  mockPatchDiff,
  mockVerificationOutput,
  mockWorkflowSteps,
  mockWorkspaceMissions,
  type MissionNodeStatus,
  type WorkspaceGraphEdge,
  type WorkspaceGraphNode,
  type WorkspaceMission,
} from "./mockMission";
import type { Repository } from "./domain";
import {
  workspaceViewFromMissionLoop,
  type WorkspaceRuntime,
  type WorkspaceRuntimeMap,
} from "./workspaceAdapter";
import { workerMissionFixture } from "./workerMissionFixture";

const activeMissionLoop = workerMissionFixture;

const initialWorkspaceView = workspaceViewFromMissionLoop(activeMissionLoop, {
  missions: mockWorkspaceMissions,
  graphNodes: mockGraphNodes,
  graphEdges: mockGraphEdges,
  runtimeByMission: Object.fromEntries(
    mockWorkspaceMissions.map((mission) => [
      mission.id,
      {
        step: mission.step,
        patchStatus: mission.patch_status,
        verified: mission.verified,
      },
    ]),
  ) as WorkspaceRuntimeMap,
  patchDiffByMission: Object.fromEntries(mockWorkspaceMissions.map((mission) => [mission.id, mockPatchDiff])),
  verificationOutputByMission: Object.fromEntries(mockWorkspaceMissions.map((mission) => [mission.id, mockVerificationOutput])),
  activityByMission: Object.fromEntries(mockWorkspaceMissions.map((mission) => [mission.id, mockWorkflowSteps])),
});

export function App() {
  const [selectedNodeId, setSelectedNodeId] = useState("mission_version");
  const [missionDraft, setMissionDraft] = useState("stabilize the release path");
  const [workspaceMissions, setWorkspaceMissions] = useState(initialWorkspaceView.missions);
  const [workspaceGraphNodes, setWorkspaceGraphNodes] = useState(initialWorkspaceView.graphNodes);
  const [workspaceGraphEdges, setWorkspaceGraphEdges] = useState(initialWorkspaceView.graphEdges);
  const [runtimeByMission, setRuntimeByMission] = useState<WorkspaceRuntimeMap>(initialWorkspaceView.runtimeByMission);
  const [patchDiffByMission, setPatchDiffByMission] = useState(initialWorkspaceView.patchDiffByMission);
  const [verificationOutputByMission, setVerificationOutputByMission] = useState(initialWorkspaceView.verificationOutputByMission);
  const [activityByMission, setActivityByMission] = useState(initialWorkspaceView.activityByMission);

  const selectedGraphNode = workspaceGraphNodes.find((node) => node.id === selectedNodeId) ?? workspaceGraphNodes[0];
  const selectedMissionId = selectedGraphNode.mission_id ?? nearestMissionId(selectedGraphNode, workspaceMissions) ?? workspaceMissions[0].id;
  const selectedMission = workspaceMissions.find((mission) => mission.id === selectedMissionId) ?? workspaceMissions[0];
  const selectedRepository = repositoryFor(selectedMission, activeMissionLoop.repositories);
  const selectedRuntime = runtimeByMission[selectedMission.id];
  const selectedPatchDiff = patchDiffByMission[selectedMission.id] ?? "";
  const selectedVerificationOutput = verificationOutputByMission[selectedMission.id] ?? "";
  const patchReady = selectedRuntime.step >= mockWorkflowSteps.length - 1;
  const selectedActivity = activityByMission[selectedMission.id] ?? [];
  const activity = selectedActivity.slice(0, selectedRuntime.step + 1);
  const missionStatus = missionStatusFor(selectedRuntime, patchReady);
  const visibleMissions = useMemo(
    () =>
      workspaceMissions.map((mission) => ({
        ...mission,
        runtime: runtimeByMission[mission.id],
      })),
    [runtimeByMission, workspaceMissions],
  );
  const graphNodes = useMemo(
    () =>
      workspaceGraphNodes.map((node) => ({
        ...node,
        status: node.mission_id ? statusFromRuntime(runtimeByMission[node.mission_id]) : undefined,
      })),
    [runtimeByMission, workspaceGraphNodes],
  );

  const updateSelectedRuntime = (next: (runtime: WorkspaceRuntime) => WorkspaceRuntime) => {
    setRuntimeByMission((current) => ({
      ...current,
      [selectedMission.id]: next(current[selectedMission.id]),
    }));
  };

  const startMission = () => {
    updateSelectedRuntime(() => ({ step: 0, patchStatus: "pending", verified: false }));
  };

  const queueMission = () => {
    const title = missionDraft.trim();
    if (!title) {
      return;
    }

    const missionId = `mission_${Date.now()}`;
    const targetRepositoryId = selectedRepository.id;
    const targetMissionCount = workspaceMissions.filter((mission) => mission.repository_id === targetRepositoryId).length;
    const mission: WorkspaceMission = {
      id: missionId,
      repository_id: targetRepositoryId,
      title,
      status: "running",
      worker: "mock",
      command: "npm run build",
      files: ["src/App.tsx"],
      step: 0,
      patch_status: "pending",
      verified: false,
      map_position: "center",
    };
    const missionNode: WorkspaceGraphNode = {
      id: missionId,
      kind: "mission",
      label: missionLabel(title),
      detail: "mission",
      x: 27,
      y: Math.min(92, 22 + targetMissionCount * 12),
      mission_id: missionId,
      repository_id: targetRepositoryId,
    };
    const edge: WorkspaceGraphEdge = {
      id: `edge_${targetRepositoryId}_${missionId}`,
      from: targetRepositoryId,
      to: missionId,
      kind: "owns",
    };

    setWorkspaceMissions((current) => [...current, mission]);
    setWorkspaceGraphNodes((current) => [...current, missionNode]);
    setWorkspaceGraphEdges((current) => [...current, edge]);
    setRuntimeByMission((current) => ({
      ...current,
      [missionId]: {
        step: mission.step,
        patchStatus: mission.patch_status,
        verified: mission.verified,
      },
    }));
    setPatchDiffByMission((current) => ({ ...current, [missionId]: "" }));
    setVerificationOutputByMission((current) => ({ ...current, [missionId]: "" }));
    setActivityByMission((current) => ({ ...current, [missionId]: ["Mission intent captured."] }));
    setSelectedNodeId(missionId);
  };

  const advanceStep = () => {
    updateSelectedRuntime((current) => ({
      ...current,
      step: Math.min(current.step + 1, mockWorkflowSteps.length - 1),
    }));
  };

  const approvePatch = () => {
    updateSelectedRuntime((current) => ({ ...current, patchStatus: "approved" }));
  };

  const rejectPatch = () => {
    updateSelectedRuntime((current) => ({ ...current, patchStatus: "rejected" }));
  };

  const runVerification = () => {
    updateSelectedRuntime((current) => ({ ...current, verified: true }));
  };

  return (
    <main className="control-deck">
      <aside className="command-rail">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <CircleDot size={20} />
          </div>
          <div>
            <h1>Orbital</h1>
            <p>Local mission control</p>
          </div>
        </div>

        <section className="console-panel launch-console" aria-label="New mission">
          <div className="section-label">Mission intake</div>
          <textarea
            aria-label="Mission intent"
            value={missionDraft}
            onChange={(event) => setMissionDraft(event.target.value)}
          />
          <button className="primary command-button" type="button" onClick={queueMission} disabled={!missionDraft.trim()}>
            <Rocket size={17} aria-hidden="true" />
            <span>Queue mission</span>
          </button>
        </section>

        <section className="console-panel fleet-console" aria-label="Workspace telemetry">
          <div className="section-label">Workspace telemetry</div>
          <dl className="metric-grid">
            <div>
              <dt>Repos</dt>
              <dd>{activeMissionLoop.repositories.length}</dd>
            </div>
            <div>
              <dt>Missions</dt>
              <dd>{workspaceMissions.length}</dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>{visibleMissions.filter((mission) => isReviewing(mission.runtime)).length}</dd>
            </div>
          </dl>
          <div className="telemetry-stack">
            <TelemetryLine label="Running" value={String(visibleMissions.filter((mission) => isRunning(mission.runtime)).length)} />
            <TelemetryLine label="Blocked" value={String(visibleMissions.filter((mission) => mission.runtime.patchStatus === "rejected").length)} />
            <TelemetryLine label="Verified" value={String(visibleMissions.filter((mission) => mission.runtime.verified).length)} />
          </div>
        </section>
      </aside>

      <section className="mission-stage" aria-label="Orbital command map">
        <header className="stage-header">
          <div>
            <div className="section-label">Constellation map</div>
            <h2>Repositories, missions, workers, files, and gates in one graph</h2>
          </div>
          <div className={`status-pill ${missionStatus.className}`}>{missionStatus.label}</div>
        </header>

        <GraphMap
          nodes={graphNodes}
          edges={workspaceGraphEdges}
          selectedNodeId={selectedGraphNode.id}
          selectedMissionId={selectedMission.id}
          onSelectNode={setSelectedNodeId}
        />
      </section>

      <aside className="systems-rail">
        <section className="console-panel selected-console" aria-label="Selected node">
          <div className="panel-head">
            <div>
              <div className="section-label">Inspector</div>
              <h2>{selectedGraphNode.label}</h2>
            </div>
            <MissionGlyph status={statusFromRuntime(selectedRuntime)} />
          </div>
          <NodeInspector
            node={selectedGraphNode}
            mission={selectedMission}
            missions={workspaceMissions}
            repositories={activeMissionLoop.repositories}
            runtime={selectedRuntime}
          />
        </section>

        <section className="console-panel activity-console" aria-label="Agent activity">
          <div className="panel-head">
            <div>
              <div className="section-label">Agent</div>
              <h2>Run stream</h2>
            </div>
            <button
              className="secondary icon-button"
              type="button"
              onClick={selectedRuntime.step < 0 ? startMission : advanceStep}
              disabled={selectedRuntime.step >= mockWorkflowSteps.length - 1 || selectedRuntime.patchStatus !== "pending"}
              aria-label="Advance run"
              title="Advance run"
            >
              <Play size={16} aria-hidden="true" />
            </button>
          </div>
          <ol className="activity-list">
            {activity.length === 0 ? <li className="quiet">Mission is queued outside the active lane.</li> : null}
            {activity.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>

        <section className="console-panel patch-console" aria-label="Patch">
          <div className="panel-head">
            <div>
              <div className="section-label">Patch</div>
              <h2>Approval gate</h2>
            </div>
            <div className={`mini-state ${patchStateClass(selectedRuntime, patchReady)}`}>
              {patchStateLabel(selectedRuntime, patchReady)}
            </div>
          </div>
          <pre className="diff">
            <code>{patchReady ? selectedPatchDiff || "No patch proposal captured for this mission." : "Patch stream locked until this mission reaches review."}</code>
          </pre>
          <div className="actions">
            <button
              className="secondary"
              type="button"
              disabled={!patchReady || selectedRuntime.patchStatus !== "pending"}
              onClick={rejectPatch}
            >
              <X size={16} aria-hidden="true" />
              <span>Reject</span>
            </button>
            <button
              className="primary"
              type="button"
              disabled={!patchReady || selectedRuntime.patchStatus !== "pending"}
              onClick={approvePatch}
            >
              <Check size={16} aria-hidden="true" />
              <span>Approve</span>
            </button>
          </div>
        </section>

        <section className="console-panel verify-console" aria-label="Verification">
          <div className="panel-head">
            <div>
              <div className="section-label">Verification</div>
              <h2>Command relay</h2>
            </div>
            <button
              className="secondary icon-button"
              type="button"
              disabled={selectedRuntime.patchStatus !== "approved" || selectedRuntime.verified}
              onClick={runVerification}
              aria-label="Run verification"
              title="Run verification"
            >
              <Terminal size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="command-line">{selectedMission.command}</div>
          <pre className="test-output">{verificationOutput(selectedRuntime, selectedVerificationOutput)}</pre>
        </section>
      </aside>
    </main>
  );
}

function MissionGlyph({ status }: { status: MissionNodeStatus }) {
  const Icon = status === "verified" ? ShieldCheck : status === "review" || status === "approved" ? Zap : RadioTower;

  return (
    <span className={`mission-glyph ${status}`}>
      <Icon size={15} aria-hidden="true" />
    </span>
  );
}

function TelemetryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="telemetry-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NodeInspector({
  node,
  mission,
  missions,
  repositories,
  runtime,
}: {
  node: WorkspaceGraphNode;
  mission: WorkspaceMission;
  missions: WorkspaceMission[];
  repositories: Repository[];
  runtime: WorkspaceRuntime;
}) {
  const repository = node.repository_id
    ? repositories.find((repo) => repo.id === node.repository_id)
    : repositoryFor(mission, repositories);

  if (node.kind === "repo") {
    const missionCount = missions.filter((item) => item.repository_id === node.repository_id).length;
    return (
      <div className="selected-meta">
        <span>
          <Network size={14} aria-hidden="true" />
          {repository?.path ?? "Unknown repository"}
        </span>
        <span>
          <RadioTower size={14} aria-hidden="true" />
          {missionCount} missions
        </span>
        <span>
          <Terminal size={14} aria-hidden="true" />
          branch {repository?.branch ?? "unknown"}
        </span>
      </div>
    );
  }

  if (node.kind === "worker") {
    return (
      <div className="selected-meta">
        <span>
          <RadioTower size={14} aria-hidden="true" />
          local worker pool
        </span>
        <span>
          <Network size={14} aria-hidden="true" />
          attached to active mission lanes
        </span>
        <span>
          <Terminal size={14} aria-hidden="true" />
          status ready
        </span>
      </div>
    );
  }

  if (node.kind === "file") {
    return (
      <div className="selected-meta">
        <span>
          <Network size={14} aria-hidden="true" />
          {repository?.name ?? "workspace"}
        </span>
        <span>
          <RadioTower size={14} aria-hidden="true" />
          context for {mission.title}
        </span>
        <span>
          <Terminal size={14} aria-hidden="true" />
          {node.label}
        </span>
      </div>
    );
  }

  if (node.kind === "patch") {
    return (
      <div className="selected-meta">
        <span>
          <Network size={14} aria-hidden="true" />
          {mission.title}
        </span>
        <span>
          <RadioTower size={14} aria-hidden="true" />
          patch {runtime.patchStatus}
        </span>
        <span>
          <Terminal size={14} aria-hidden="true" />
          approval gate
        </span>
      </div>
    );
  }

  if (node.kind === "verification" || node.kind === "test") {
    return (
      <div className="selected-meta">
        <span>
          <Network size={14} aria-hidden="true" />
          {repository?.name ?? mission.title}
        </span>
        <span>
          <RadioTower size={14} aria-hidden="true" />
          {runtime.verified ? "verified" : "waiting"}
        </span>
        <span>
          <Terminal size={14} aria-hidden="true" />
          {mission.command}
        </span>
      </div>
    );
  }

  return (
    <div className="selected-meta">
      <span>
        <Network size={14} aria-hidden="true" />
        {repository?.name ?? "workspace"}
      </span>
      <span>
        <RadioTower size={14} aria-hidden="true" />
        {mission.worker}
      </span>
      <span>
        <Terminal size={14} aria-hidden="true" />
        {mission.command}
      </span>
    </div>
  );
}

function repositoryFor(mission: WorkspaceMission, repositories: Repository[]) {
  return repositories.find((repository) => repository.id === mission.repository_id) ?? repositories[0];
}

function nearestMissionId(node: WorkspaceGraphNode, missions: WorkspaceMission[]) {
  if (node.repository_id) {
    return missions.find((mission) => mission.repository_id === node.repository_id)?.id;
  }

  return undefined;
}

function missionLabel(title: string) {
  const words = title.split(/\s+/).filter(Boolean);
  return words.slice(0, 3).join(" ");
}

function statusFromRuntime(runtime: WorkspaceRuntime): MissionNodeStatus {
  if (runtime.verified) {
    return "verified";
  }
  if (runtime.patchStatus === "approved") {
    return "approved";
  }
  if (runtime.patchStatus === "rejected") {
    return "blocked";
  }
  if (runtime.step >= mockWorkflowSteps.length - 1) {
    return "review";
  }
  if (runtime.step >= 0) {
    return "running";
  }
  return "draft";
}

function missionStatusFor(runtime: WorkspaceRuntime, patchReady: boolean) {
  const status = statusFromRuntime(runtime);
  if (status === "verified") {
    return { label: "Verified", className: "done" };
  }
  if (status === "approved") {
    return { label: "Approved", className: "active" };
  }
  if (status === "blocked") {
    return { label: "Blocked", className: "rejected" };
  }
  if (status === "review") {
    return { label: patchReady ? "Review" : "Running", className: "active" };
  }
  if (status === "running") {
    return { label: "Running", className: "active" };
  }
  return { label: "Queued", className: "idle" };
}

function isRunning(runtime: WorkspaceRuntime) {
  return statusFromRuntime(runtime) === "running";
}

function isReviewing(runtime: WorkspaceRuntime) {
  return statusFromRuntime(runtime) === "review";
}

function patchStateLabel(runtime: WorkspaceRuntime, patchReady: boolean) {
  if (runtime.patchStatus === "approved") {
    return "Approved";
  }
  if (runtime.patchStatus === "rejected") {
    return "Rejected";
  }
  return patchReady ? "Ready" : "Cold";
}

function patchStateClass(runtime: WorkspaceRuntime, patchReady: boolean) {
  if (runtime.patchStatus === "approved") {
    return "done";
  }
  if (runtime.patchStatus === "rejected") {
    return "rejected";
  }
  return patchReady ? "active" : "";
}

function verificationOutput(runtime: WorkspaceRuntime, output: string) {
  if (runtime.verified) {
    return output || "Verification passed.";
  }
  if (runtime.patchStatus === "approved") {
    return "Patch approved. Verification command is armed.";
  }
  if (runtime.patchStatus === "rejected") {
    return "Patch rejected. Mission stopped before file changes.";
  }
  return "Waiting for approved patch.";
}
