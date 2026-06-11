import { useMemo, useState } from "react";
import {
  Check,
  CircleDot,
  Code2,
  FileCode2,
  GitBranch,
  Network,
  Play,
  RadioTower,
  Rocket,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
  Zap,
} from "lucide-react";

type NodeStatus = "pending" | "active" | "working" | "done" | "rejected";
type PatchStatus = "pending" | "approved" | "rejected";

type MissionState = {
  step: number;
  patchStatus: PatchStatus;
  verified: boolean;
};

type OrbitNode = {
  id: string;
  label: string;
  detail: string;
  status: NodeStatus;
  icon: typeof Network;
  position: string;
};

const steps = [
  "Mission intent captured.",
  "Worker linked to repository graph.",
  "package.json streamed into context.",
  "src/cli.ts routed into context.",
  "Patch assembled for version command.",
  "Patch waiting at approval gate.",
];

const proposedDiff = `diff --git a/package.json b/package.json
index 2b13a1c..91d44fd 100644
--- a/package.json
+++ b/package.json
@@ -4,6 +4,7 @@
   "bin": {
     "demo": "./dist/cli.js"
   },
+  "version": "0.1.0",
   "scripts": {
     "build": "tsc",
     "test": "vitest run"
diff --git a/src/cli.ts b/src/cli.ts
index 8b891fa..7f1c0db 100644
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -1,6 +1,11 @@
 import pkg from "../package.json";

 const command = process.argv[2];

+if (command === "version" || command === "--version") {
+  console.log(pkg.version);
+  process.exit(0);
+}
+
 console.log("Usage: demo <command>");`;

const initialState: MissionState = {
  step: -1,
  patchStatus: "pending",
  verified: false,
};

export function App() {
  const [missionText, setMissionText] = useState("add a version command");
  const [missionState, setMissionState] = useState<MissionState>(initialState);

  const title = missionText.trim() || "Untitled mission";
  const patchReady = missionState.step >= 5;
  const activity = steps.slice(0, missionState.step + 1);
  const progress = missionState.verified
    ? 100
    : missionState.patchStatus === "approved"
      ? 82
      : missionState.patchStatus === "rejected"
        ? 62
        : Math.max(0, Math.round(((missionState.step + 1) / steps.length) * 72));

  const missionStatus = useMemo(() => missionStatusFor(missionState, patchReady), [missionState, patchReady]);
  const orbitNodes = useMemo(() => buildOrbitNodes(missionState, patchReady), [missionState, patchReady]);

  const startMission = () => {
    setMissionState({ step: 0, patchStatus: "pending", verified: false });
  };

  const advanceStep = () => {
    setMissionState((current) => ({
      ...current,
      step: Math.min(current.step + 1, steps.length - 1),
    }));
  };

  const approvePatch = () => {
    setMissionState((current) => ({ ...current, patchStatus: "approved" }));
  };

  const rejectPatch = () => {
    setMissionState((current) => ({ ...current, patchStatus: "rejected" }));
  };

  const runVerification = () => {
    setMissionState((current) => ({ ...current, verified: true }));
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

        <section className="console-panel repo-console" aria-label="Repository">
          <div className="panel-head compact">
            <div>
              <div className="section-label">Repository</div>
              <h2>demo-cli</h2>
            </div>
            <GitBranch size={18} aria-hidden="true" />
          </div>
          <button className="repo-button" type="button">
            <Network size={16} aria-hidden="true" />
            <span>/Users/akomov/dev/demo-cli</span>
          </button>
          <dl className="metric-grid">
            <div>
              <dt>Areas</dt>
              <dd>4</dd>
            </div>
            <div>
              <dt>Tests</dt>
              <dd>18</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>main</dd>
            </div>
          </dl>
        </section>

        <section className="console-panel mission-console" aria-label="Mission">
          <div className="section-label">Mission intent</div>
          <textarea
            aria-label="Mission intent"
            value={missionText}
            onChange={(event) => setMissionText(event.target.value)}
          />
          <button className="primary command-button" type="button" onClick={startMission}>
            <Rocket size={17} aria-hidden="true" />
            <span>Start mission</span>
          </button>
        </section>

        <section className="console-panel telemetry-console" aria-label="Mission telemetry">
          <div className="section-label">Telemetry</div>
          <div className="telemetry-stack">
            <TelemetryLine label="Context lock" value={missionState.step >= 3 ? "Synced" : "Seeking"} />
            <TelemetryLine label="Patch gate" value={patchReady ? patchGateLabel(missionState.patchStatus) : "Cold"} />
            <TelemetryLine label="Verifier" value={missionState.verified ? "Passed" : missionState.patchStatus === "approved" ? "Armed" : "Idle"} />
          </div>
        </section>
      </aside>

      <section className="mission-stage" aria-label="Mission system">
        <header className="stage-header">
          <div>
            <div className="section-label">Active mission</div>
            <h2>{title}</h2>
          </div>
          <div className={`status-pill ${missionStatus.className}`}>{missionStatus.label}</div>
        </header>

        <section className="orbital-map" aria-label="Mission graph">
          <div className="starfield" aria-hidden="true" />
          <div className="scanline" aria-hidden="true" />
          <div className="orbit orbit-one" aria-hidden="true" />
          <div className="orbit orbit-two" aria-hidden="true" />
          <div className="orbit orbit-three" aria-hidden="true" />
          <div className="signal signal-a" aria-hidden="true" />
          <div className="signal signal-b" aria-hidden="true" />
          <div className="signal signal-c" aria-hidden="true" />

          <div className={`mission-core ${missionStatus.className}`}>
            <div className="core-ring" aria-hidden="true" />
            <div className="core-shell">
              <Sparkles size={22} aria-hidden="true" />
              <span>Mission core</span>
              <strong>{title}</strong>
              <div className="core-progress" aria-label={`Mission progress ${progress}%`}>
                <span style={{ width: `${progress}%` }} />
              </div>
              <small>{progress}% synchronized</small>
            </div>
          </div>

          {orbitNodes.map((node) => (
            <OrbitNodeView key={node.id} node={node} />
          ))}
        </section>
      </section>

      <aside className="systems-rail">
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
              disabled={missionState.step >= steps.length - 1 || missionState.patchStatus !== "pending"}
              aria-label="Advance run"
              title="Advance run"
            >
              <Play size={16} aria-hidden="true" />
            </button>
          </div>
          <ol className="activity-list">
            {activity.length === 0 ? <li className="quiet">Awaiting mission ignition.</li> : null}
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
            <div className={`mini-state ${patchStateClass(missionState, patchReady)}`}>
              {patchStateLabel(missionState, patchReady)}
            </div>
          </div>
          <pre className="diff">
            <code>{patchReady ? proposedDiff : "Patch stream locked until agent inspection completes."}</code>
          </pre>
          <div className="actions">
            <button
              className="secondary"
              type="button"
              disabled={!patchReady || missionState.patchStatus !== "pending"}
              onClick={rejectPatch}
            >
              <X size={16} aria-hidden="true" />
              <span>Reject</span>
            </button>
            <button
              className="primary"
              type="button"
              disabled={!patchReady || missionState.patchStatus !== "pending"}
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
              disabled={missionState.patchStatus !== "approved" || missionState.verified}
              onClick={runVerification}
              aria-label="Run verification"
              title="Run verification"
            >
              <Terminal size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="command-line">npm test</div>
          <pre className="test-output">{verificationOutput(missionState)}</pre>
        </section>
      </aside>
    </main>
  );
}

function OrbitNodeView({ node }: { node: OrbitNode }) {
  const Icon = node.icon;

  return (
    <article className={`orbit-node ${node.status} ${node.position}`}>
      <div className="node-icon">
        <Icon size={18} aria-hidden="true" />
      </div>
      <div>
        <span>{node.label}</span>
        <strong>{node.detail}</strong>
      </div>
    </article>
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

function buildOrbitNodes(state: MissionState, patchReady: boolean): OrbitNode[] {
  return [
    {
      id: "repo",
      label: "Repo graph",
      detail: "demo-cli",
      status: "active",
      icon: Network,
      position: "pos-repo",
    },
    {
      id: "agent",
      label: "Worker",
      detail: state.step >= 5 ? "patch proposed" : state.step >= 1 ? "running" : "standing by",
      status: state.step >= 1 ? "working" : "pending",
      icon: RadioTower,
      position: "pos-agent",
    },
    {
      id: "package",
      label: "Context",
      detail: "package.json",
      status: state.step >= 2 ? "done" : "pending",
      icon: FileCode2,
      position: "pos-package",
    },
    {
      id: "cli",
      label: "Context",
      detail: "src/cli.ts",
      status: state.step >= 3 ? "done" : "pending",
      icon: Code2,
      position: "pos-cli",
    },
    {
      id: "patch",
      label: "Patch",
      detail: patchReady ? patchGateLabel(state.patchStatus) : "assembling",
      status: patchNodeStatus(state, patchReady),
      icon: Zap,
      position: "pos-patch",
    },
    {
      id: "verify",
      label: "Verify",
      detail: verifyNodeDetail(state),
      status: verifyNodeStatus(state),
      icon: ShieldCheck,
      position: "pos-verify",
    },
  ];
}

function missionStatusFor(state: MissionState, patchReady: boolean) {
  if (state.verified) {
    return { label: "Verified", className: "done" };
  }
  if (state.patchStatus === "approved") {
    return { label: "Approved", className: "active" };
  }
  if (state.patchStatus === "rejected") {
    return { label: "Rejected", className: "rejected" };
  }
  if (state.step >= 0) {
    return { label: patchReady ? "Review" : "Running", className: "active" };
  }
  return { label: "Draft", className: "idle" };
}

function patchNodeStatus(state: MissionState, patchReady: boolean): NodeStatus {
  if (state.patchStatus === "approved") {
    return "done";
  }
  if (state.patchStatus === "rejected") {
    return "rejected";
  }
  return patchReady ? "active" : "pending";
}

function verifyNodeStatus(state: MissionState): NodeStatus {
  if (state.verified) {
    return "done";
  }
  if (state.patchStatus === "approved") {
    return "active";
  }
  if (state.patchStatus === "rejected") {
    return "rejected";
  }
  return "pending";
}

function verifyNodeDetail(state: MissionState) {
  if (state.verified) {
    return "passed";
  }
  if (state.patchStatus === "approved") {
    return "armed";
  }
  if (state.patchStatus === "rejected") {
    return "stopped";
  }
  return "blocked";
}

function patchGateLabel(status: PatchStatus) {
  if (status === "approved") {
    return "approved";
  }
  if (status === "rejected") {
    return "rejected";
  }
  return "ready";
}

function patchStateLabel(state: MissionState, patchReady: boolean) {
  if (state.patchStatus === "approved") {
    return "Approved";
  }
  if (state.patchStatus === "rejected") {
    return "Rejected";
  }
  return patchReady ? "Ready" : "Cold";
}

function patchStateClass(state: MissionState, patchReady: boolean) {
  if (state.patchStatus === "approved") {
    return "done";
  }
  if (state.patchStatus === "rejected") {
    return "rejected";
  }
  return patchReady ? "active" : "";
}

function verificationOutput(state: MissionState) {
  if (state.verified) {
    return `> npm test

 PASS  src/cli.test.ts
  version command prints 0.1.0

Test Files  1 passed
Duration    0.8s`;
  }
  if (state.patchStatus === "approved") {
    return "Patch approved. Verification command is armed.";
  }
  if (state.patchStatus === "rejected") {
    return "Patch rejected. Mission stopped before file changes.";
  }
  return "Waiting for approved patch.";
}
