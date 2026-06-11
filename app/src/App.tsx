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
import type { PatchStatus as WorkerPatchStatus } from "./domain";
import {
  mockMissionLoop,
  mockGraphNodes,
  mockPatchDiff,
  mockVerificationOutput,
  mockWorkflowSteps,
  mockWorkspaceMissions,
  type MissionNodeStatus,
  type WorkspaceMission,
} from "./mockMission";

type PatchStatus = Extract<WorkerPatchStatus, "pending" | "approved" | "rejected">;

type MissionRuntime = {
  step: number;
  patchStatus: PatchStatus;
  verified: boolean;
};

type MissionRuntimeMap = Record<string, MissionRuntime>;

const initialMissionRuntime = Object.fromEntries(
  mockWorkspaceMissions.map((mission) => [
    mission.id,
    {
      step: mission.step,
      patchStatus: mission.patch_status,
      verified: mission.verified,
    },
  ]),
) as MissionRuntimeMap;

export function App() {
  const [selectedMissionId, setSelectedMissionId] = useState(mockWorkspaceMissions[0].id);
  const [missionDraft, setMissionDraft] = useState("stabilize the release path");
  const [runtimeByMission, setRuntimeByMission] = useState<MissionRuntimeMap>(initialMissionRuntime);

  const selectedMission = mockWorkspaceMissions.find((mission) => mission.id === selectedMissionId) ?? mockWorkspaceMissions[0];
  const selectedRepository = repositoryFor(selectedMission);
  const selectedRuntime = runtimeByMission[selectedMission.id];
  const patchReady = selectedRuntime.step >= mockWorkflowSteps.length - 1;
  const activity = mockWorkflowSteps.slice(0, selectedRuntime.step + 1);
  const missionStatus = missionStatusFor(selectedRuntime, patchReady);
  const visibleMissions = useMemo(
    () =>
      mockWorkspaceMissions.map((mission) => ({
        ...mission,
        runtime: runtimeByMission[mission.id],
      })),
    [runtimeByMission],
  );
  const graphNodes = useMemo(
    () =>
      mockGraphNodes.map((node) => ({
        ...node,
        status: node.mission_id ? statusFromRuntime(runtimeByMission[node.mission_id]) : undefined,
      })),
    [runtimeByMission],
  );

  const updateSelectedRuntime = (next: (runtime: MissionRuntime) => MissionRuntime) => {
    setRuntimeByMission((current) => ({
      ...current,
      [selectedMission.id]: next(current[selectedMission.id]),
    }));
  };

  const startMission = () => {
    updateSelectedRuntime(() => ({ step: 0, patchStatus: "pending", verified: false }));
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
          <button className="primary command-button" type="button">
            <Rocket size={17} aria-hidden="true" />
            <span>Queue mission</span>
          </button>
        </section>

        <section className="console-panel fleet-console" aria-label="Workspace telemetry">
          <div className="section-label">Workspace telemetry</div>
          <dl className="metric-grid">
            <div>
              <dt>Repos</dt>
              <dd>{mockMissionLoop.repositories.length}</dd>
            </div>
            <div>
              <dt>Missions</dt>
              <dd>{mockWorkspaceMissions.length}</dd>
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

        <GraphMap nodes={graphNodes} selectedMissionId={selectedMission.id} onSelectMission={setSelectedMissionId} />
      </section>

      <aside className="systems-rail">
        <section className="console-panel selected-console" aria-label="Selected mission">
          <div className="panel-head">
            <div>
              <div className="section-label">Selected mission</div>
              <h2>{selectedMission.title}</h2>
            </div>
            <MissionGlyph status={statusFromRuntime(selectedRuntime)} />
          </div>
          <div className="selected-meta">
            <span>
              <Network size={14} aria-hidden="true" />
              {selectedRepository.name}
            </span>
            <span>
              <RadioTower size={14} aria-hidden="true" />
              {selectedMission.worker}
            </span>
            <span>
              <Terminal size={14} aria-hidden="true" />
              {selectedMission.command}
            </span>
          </div>
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
              onClick={advanceStep}
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
            <code>{patchReady ? mockPatchDiff : "Patch stream locked until this mission reaches review."}</code>
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
          <pre className="test-output">{verificationOutput(selectedRuntime)}</pre>
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

function repositoryFor(mission: WorkspaceMission) {
  return (
    mockMissionLoop.repositories.find((repository) => repository.id === mission.repository_id) ?? mockMissionLoop.repositories[0]
  );
}

function statusFromRuntime(runtime: MissionRuntime): MissionNodeStatus {
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

function missionStatusFor(runtime: MissionRuntime, patchReady: boolean) {
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

function isRunning(runtime: MissionRuntime) {
  return statusFromRuntime(runtime) === "running";
}

function isReviewing(runtime: MissionRuntime) {
  return statusFromRuntime(runtime) === "review";
}

function patchStateLabel(runtime: MissionRuntime, patchReady: boolean) {
  if (runtime.patchStatus === "approved") {
    return "Approved";
  }
  if (runtime.patchStatus === "rejected") {
    return "Rejected";
  }
  return patchReady ? "Ready" : "Cold";
}

function patchStateClass(runtime: MissionRuntime, patchReady: boolean) {
  if (runtime.patchStatus === "approved") {
    return "done";
  }
  if (runtime.patchStatus === "rejected") {
    return "rejected";
  }
  return patchReady ? "active" : "";
}

function verificationOutput(runtime: MissionRuntime) {
  if (runtime.verified) {
    return mockVerificationOutput;
  }
  if (runtime.patchStatus === "approved") {
    return "Patch approved. Verification command is armed.";
  }
  if (runtime.patchStatus === "rejected") {
    return "Patch rejected. Mission stopped before file changes.";
  }
  return "Waiting for approved patch.";
}
