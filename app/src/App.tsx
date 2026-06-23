import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  CircleDot,
  Network,
  Play,
  RadioTower,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Terminal,
  FolderOpen,
  X,
  Zap,
  UserCheck,
} from "lucide-react";
import { GraphMap } from "./components/GraphMap";
import {
  type MissionNodeStatus,
  type WorkspaceGraphEdge,
  type WorkspaceGraphNode,
  type WorkspaceMission,
} from "./mockMission";
import type { MissionLoopState, PatchProposal, Repository, WorkflowEvent } from "./domain";
import {
  workspaceViewFromMissionLoop,
  type WorkspaceRuntime,
  type WorkspaceRuntimeMap,
} from "./workspaceAdapter";
import {
  approvePatchMissionLoopState,
  demoRepoPath,
  isTauriRuntime,
  loadMissionLoopState,
  openMissionLoopRepository,
  queueMissionLoopState,
  rejectPatchMissionLoopState,
  refreshMissionLoopState,
  startAgentRunMissionLoopState,
  verifyMissionLoopState,
} from "./missionLoopLoader";

const emptyMissionLoopState: MissionLoopState = {
  repositories: [],
  missions: [],
  agent_runs: [],
  workflow_events: [],
  patch_proposals: [],
  verification_runs: [],
};

const initialWorkspaceView = workspaceViewFromMissionLoop(emptyMissionLoopState);
type WorkerMode = "mock" | "local-command" | "claude-manager";

export function App() {
  const [missionLoopState, setMissionLoopState] = useState(emptyMissionLoopState);
  const [refreshingMissionLoop, setRefreshingMissionLoop] = useState(false);
  const [missionLoopError, setMissionLoopError] = useState("");
  const [repoPathDraft, setRepoPathDraft] = useState(demoRepoPath);
  const [activeRepoPath, setActiveRepoPath] = useState(demoRepoPath);
  const [selectedNodeId, setSelectedNodeId] = useState("mission_version");
  const [missionDraft, setMissionDraft] = useState("stabilize the release path");
  const [workspaceMissions, setWorkspaceMissions] = useState(initialWorkspaceView.missions);
  const [workspaceGraphNodes, setWorkspaceGraphNodes] = useState(initialWorkspaceView.graphNodes);
  const [workspaceGraphEdges, setWorkspaceGraphEdges] = useState(initialWorkspaceView.graphEdges);
  const [runtimeByMission, setRuntimeByMission] = useState<WorkspaceRuntimeMap>(initialWorkspaceView.runtimeByMission);
  const [patchDiffByMission, setPatchDiffByMission] = useState(initialWorkspaceView.patchDiffByMission);
  const [verificationOutputByMission, setVerificationOutputByMission] = useState(initialWorkspaceView.verificationOutputByMission);
  const [activityByMission, setActivityByMission] = useState(initialWorkspaceView.activityByMission);
  const [verificationCommandByMission, setVerificationCommandByMission] = useState<Record<string, string>>(
    Object.fromEntries(initialWorkspaceView.missions.map((mission) => [mission.id, mission.command])),
  );
  const [workerModeByMission, setWorkerModeByMission] = useState<Record<string, WorkerMode>>(
    Object.fromEntries(initialWorkspaceView.missions.map((mission) => [mission.id, mission.worker === "local-command" ? "local-command" : "mock"])),
  );
  const [localCommandByMission, setLocalCommandByMission] = useState<Record<string, string>>({});
  const [openPanel, setOpenPanel] = useState<null | "repo" | "mission">(null);
  const togglePanel = (panel: "repo" | "mission") => setOpenPanel((current) => (current === panel ? null : panel));

  const selectedGraphNode = workspaceGraphNodes.find((node) => node.id === selectedNodeId) ?? workspaceGraphNodes[0];
  const selectedMissionId = selectedGraphNode?.mission_id ?? nearestMissionId(selectedGraphNode, workspaceMissions) ?? workspaceMissions[0]?.id;
  const selectedMission = workspaceMissions.find((mission) => mission.id === selectedMissionId) ?? workspaceMissions[0];
  const selectedRepository = selectedMission ? repositoryFor(selectedMission, missionLoopState.repositories) : undefined;
  const selectedRuntime = (selectedMission ? runtimeByMission[selectedMission.id] : undefined) ?? { step: -1, patchStatus: "pending" as const, verified: false, status: "queued" as const };
  const selectedPatchDiff = (selectedMission ? patchDiffByMission[selectedMission.id] : undefined) ?? "";
  const selectedVerificationOutput = (selectedMission ? verificationOutputByMission[selectedMission.id] : undefined) ?? "";
  const selectedVerificationCommand = (selectedMission ? verificationCommandByMission[selectedMission.id] : undefined) ?? selectedMission?.command ?? "";
  const selectedWorkerMode = (selectedMission ? workerModeByMission[selectedMission.id] : undefined) ?? (selectedMission?.worker === "local-command" ? "local-command" : "mock");
  const selectedLocalCommand = localCommandByMission[selectedMission?.id ?? ""] ?? defaultLocalCommand();
  const patchReady = (selectedPatchDiff ?? "") !== "";
  const selectedActivity = activityByMission[selectedMission?.id ?? ""] ?? [];
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

  const runningMissionIds = useMemo(
    () => new Set(workspaceMissions.filter((m) => runtimeByMission[m.id]?.status === "running").map((m) => m.id)),
    [workspaceMissions, runtimeByMission],
  );

  const updateSelectedRuntime = (next: (runtime: WorkspaceRuntime) => WorkspaceRuntime) => {
    setRuntimeByMission((current) => ({
      ...current,
      [selectedMission.id]: next(current[selectedMission.id]),
    }));
  };

  const startMission = async () => {
    setMissionLoopError("");
    const missionId = selectedMission.id;
    console.log("[orbital] dispatch start", { missionId, worker: selectedWorkerMode, repo: activeRepoPath, tauri: isTauriRuntime() });

    let unlistenEvent: (() => void) | undefined;
    let unlistenPatch: (() => void) | undefined;

    if (isTauriRuntime()) {
      unlistenEvent = await listen<WorkflowEvent>("workflow_event", (e) => {
        const event = e.payload;
        console.log("[orbital] workflow_event", event.type, event.message);
        if (!event.message) return;
        setActivityByMission((current) => ({
          ...current,
          [missionId]: [...(current[missionId] ?? []), event.message],
        }));
        setRuntimeByMission((current) => ({
          ...current,
          [missionId]: {
            ...current[missionId],
            status: "running",
            step: (current[missionId]?.step ?? -1) + 1,
          },
        }));
      });

      unlistenPatch = await listen<PatchProposal>("patch_proposal", (e) => {
        const patch = e.payload;
        console.log("[orbital] patch_proposal received", { runId: patch.run_id, diffLength: patch.diff?.length });
        setPatchDiffByMission((current) => ({ ...current, [missionId]: patch.diff }));
        setRuntimeByMission((current) => ({
          ...current,
          [missionId]: {
            ...current[missionId],
            status: "review",
            patchStatus: "pending",
            step: (current[missionId]?.step ?? 0) + 1,
          },
        }));
      });
    }

    try {
      console.log("[orbital] invoking start_agent_run…");
      const nextMissionLoopState = await startAgentRunMissionLoopState(
        activeRepoPath,
        missionId,
        selectedWorkerMode,
        selectedWorkerMode === "local-command" ? selectedLocalCommand : undefined,
      );
      console.log("[orbital] start_agent_run returned", {
        hasState: !!nextMissionLoopState,
        missions: nextMissionLoopState?.missions?.length,
        runs: nextMissionLoopState?.agent_runs?.length,
        patches: nextMissionLoopState?.patch_proposals?.length,
      });
      if (nextMissionLoopState) {
        hydrateMissionLoop(nextMissionLoopState, missionId);
        return;
      }
    } catch (error) {
      console.error("[orbital] dispatch failed", error);
      setMissionLoopError(errorMessage(error, "Failed to dispatch mission."));
      return;
    } finally {
      unlistenEvent?.();
      unlistenPatch?.();
    }

    updateSelectedRuntime(() => ({ step: 0, patchStatus: "pending", verified: false, status: "running" }));
  };

  const queueMission = async () => {
    const title = missionDraft.trim();
    if (!title) {
      return;
    }

    setMissionLoopError("");

    try {
      const nextMissionLoopState = await queueMissionLoopState(activeRepoPath, title);
      if (nextMissionLoopState) {
        const missionId = nextMissionLoopState.missions.at(-1)?.id;
        hydrateMissionLoop(nextMissionLoopState, missionId);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to queue mission."));
      return;
    }

    if (!selectedRepository) return;
    const missionId = `mission_${Date.now()}`;
    const targetRepositoryId = selectedRepository.id;
    const targetMissionCount = workspaceMissions.filter((mission) => mission.repository_id === targetRepositoryId).length;
    const mission: WorkspaceMission = {
      id: missionId,
      repository_id: targetRepositoryId,
      title,
      status: "queued",
      worker: selectedWorkerMode,
      command: "npm run build",
      files: [],
      step: -1,
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
        status: mission.status,
      },
    }));
    setPatchDiffByMission((current) => ({ ...current, [missionId]: "" }));
    setVerificationOutputByMission((current) => ({ ...current, [missionId]: "" }));
    setActivityByMission((current) => ({ ...current, [missionId]: [] }));
    setWorkerModeByMission((current) => ({ ...current, [missionId]: selectedWorkerMode }));
    setSelectedNodeId(missionId);
  };

  const advanceStep = () => {
    updateSelectedRuntime((current) => ({
      ...current,
      step: current.step + 1,
    }));
  };

  const approvePatch = async () => {
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await approvePatchMissionLoopState(activeRepoPath, selectedMission.id);
      if (nextMissionLoopState) {
        hydrateMissionLoop(nextMissionLoopState, selectedMission.id);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to approve patch."));
      return;
    }

    updateSelectedRuntime((current) => ({ ...current, patchStatus: "approved", status: "approved" }));
  };

  const rejectPatch = async () => {
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await rejectPatchMissionLoopState(activeRepoPath, selectedMission.id);
      if (nextMissionLoopState) {
        hydrateMissionLoop(nextMissionLoopState, selectedMission.id);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to reject patch."));
      return;
    }

    updateSelectedRuntime((current) => ({ ...current, patchStatus: "rejected", status: "blocked" }));
  };

  const runVerification = async () => {
    const command = selectedVerificationCommand.trim();
    if (!command) {
      setMissionLoopError("Verification command is required.");
      return;
    }

    setMissionLoopError("");

    try {
      const nextMissionLoopState = await verifyMissionLoopState(activeRepoPath, selectedMission.id, command);
      if (nextMissionLoopState) {
        hydrateMissionLoop(nextMissionLoopState, selectedMission.id);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to run verification."));
      return;
    }

    updateSelectedRuntime((current) => ({ ...current, verified: true, status: "verified" }));
  };

  const hydrateMissionLoop = (nextMissionLoopState: MissionLoopState, preferredNodeId?: string) => {
    const nextWorkspaceView = workspaceViewFromMissionLoop(nextMissionLoopState);
    console.log("[orbital] hydrate", {
      preferredNodeId,
      patchDiffByMission: Object.fromEntries(
        Object.entries(nextWorkspaceView.patchDiffByMission).map(([k, v]) => [k, v ? `${v.length} chars` : "empty"]),
      ),
      runtimeByMission: nextWorkspaceView.runtimeByMission,
    });

    setMissionLoopState(nextMissionLoopState);
    setWorkspaceMissions(nextWorkspaceView.missions);
    setWorkspaceGraphNodes(nextWorkspaceView.graphNodes);
    setWorkspaceGraphEdges(nextWorkspaceView.graphEdges);
    setRuntimeByMission(nextWorkspaceView.runtimeByMission);
    setPatchDiffByMission(nextWorkspaceView.patchDiffByMission);
    setVerificationOutputByMission(nextWorkspaceView.verificationOutputByMission);
    setActivityByMission(nextWorkspaceView.activityByMission);
    setVerificationCommandByMission((current) => ({
      ...Object.fromEntries(nextWorkspaceView.missions.map((mission) => [mission.id, current[mission.id] ?? mission.command])),
    }));
    setWorkerModeByMission((current) => ({
      ...Object.fromEntries(
        nextWorkspaceView.missions.map((mission) => [
          mission.id,
          current[mission.id] ?? (mission.worker === "local-command" ? "local-command" : "mock"),
        ]),
      ),
    }));
    setSelectedNodeId((current) => {
      if (preferredNodeId && nextWorkspaceView.graphNodes.some((node) => node.id === preferredNodeId)) {
        return preferredNodeId;
      }

      return nextWorkspaceView.graphNodes.some((node) => node.id === current)
        ? current
        : nextWorkspaceView.graphNodes[0]?.id ?? current;
    });
  };

  const openWorkspace = async () => {
    const repoPath = repoPathDraft.trim();
    if (!repoPath) {
      return;
    }

    setRefreshingMissionLoop(true);
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await openMissionLoopRepository(repoPath);
      if (nextMissionLoopState) {
        setActiveRepoPath(repoPath);
        hydrateMissionLoop(nextMissionLoopState);
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to open repository."));
    } finally {
      setRefreshingMissionLoop(false);
    }
  };

  const chooseWorkspaceFolder = async () => {
    setMissionLoopError("");

    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose repository folder",
      });
      const repoPath = Array.isArray(selected) ? selected[0] : selected;
      if (!repoPath) {
        return;
      }

      setRepoPathDraft(repoPath);
      setRefreshingMissionLoop(true);
      const nextMissionLoopState = await openMissionLoopRepository(repoPath);
      if (nextMissionLoopState) {
        setActiveRepoPath(repoPath);
        hydrateMissionLoop(nextMissionLoopState);
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to choose repository folder."));
    } finally {
      setRefreshingMissionLoop(false);
    }
  };

  const loadDemoFactory = async () => {
    setRepoPathDraft(demoRepoPath);
    setActiveRepoPath(demoRepoPath);
    await refreshMissionLoop();
  };

  const refreshMissionLoop = async () => {
    setRefreshingMissionLoop(true);
    setMissionLoopError("");

    try {
      hydrateMissionLoop(activeRepoPath === demoRepoPath ? await refreshMissionLoopState() : await loadMissionLoopState(activeRepoPath));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to load mission loop state."));
    } finally {
      setRefreshingMissionLoop(false);
    }
  };

  useEffect(() => {
    const loadMissionLoop = async () => {
      setRefreshingMissionLoop(true);
      setMissionLoopError("");

      try {
        hydrateMissionLoop(await loadMissionLoopState(activeRepoPath));
      } catch (error) {
        setMissionLoopError(errorMessage(error, "Failed to load mission loop state."));
      } finally {
        setRefreshingMissionLoop(false);
      }
    };

    void loadMissionLoop();
  }, []);

  return (
    <main className="canvas-shell">
      <GraphMap
        nodes={graphNodes}
        edges={workspaceGraphEdges}
        selectedNodeId={selectedGraphNode?.id ?? ""}
        selectedMissionId={selectedMission?.id ?? ""}
        runningMissionIds={runningMissionIds}
        onSelectNode={setSelectedNodeId}
      />

      <header className="topbar">
        <div className="topbar-brand">
          <CircleDot size={18} aria-hidden="true" />
          <span>Orbital</span>
        </div>
        <div className="topbar-group">
          <button
            className={`chip ${openPanel === "repo" ? "active" : ""}`}
            type="button"
            onClick={() => togglePanel("repo")}
            title={activeRepoPath}
          >
            <FolderOpen size={15} aria-hidden="true" />
            <span>{repoLabel(selectedRepository?.name, activeRepoPath)}</span>
          </button>
          <button
            className={`chip primary-chip ${openPanel === "mission" ? "active" : ""}`}
            type="button"
            onClick={() => togglePanel("mission")}
          >
            <Rocket size={15} aria-hidden="true" />
            <span>Mission</span>
          </button>
          <button
            className="chip icon"
            type="button"
            onClick={refreshMissionLoop}
            disabled={refreshingMissionLoop}
            aria-label="Refresh mission loop"
            title="Refresh mission loop"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="topbar-spacer" />
        <div className="topbar-metrics">
          <span><strong>{missionLoopState.repositories.length}</strong> repos</span>
          <span><strong>{workspaceMissions.length}</strong> missions</span>
          <span><strong>{visibleMissions.filter((mission) => isRunning(mission.runtime)).length}</strong> running</span>
          <span><strong>{visibleMissions.filter((mission) => mission.runtime.verified).length}</strong> verified</span>
        </div>
      </header>

      {openPanel === "repo" ? (
        <section className="popover repo-popover" aria-label="Workspace">
          <div className="section-label">Workspace</div>
          <div className="workspace-input-row">
            <input
              aria-label="Repository path"
              placeholder="/path/to/repository"
              value={repoPathDraft}
              onChange={(event) => setRepoPathDraft(event.target.value)}
            />
            <button
              className="secondary icon-button"
              type="button"
              onClick={chooseWorkspaceFolder}
              disabled={refreshingMissionLoop}
              title="Browse for a folder"
              aria-label="Browse for a folder"
            >
              <FolderOpen size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="actions workspace-actions">
            <button className="secondary" type="button" onClick={loadDemoFactory} disabled={refreshingMissionLoop}>
              <RefreshCw size={16} aria-hidden="true" />
              <span>Demo</span>
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => {
                void openWorkspace();
                setOpenPanel(null);
              }}
              disabled={!repoPathDraft.trim() || refreshingMissionLoop}
            >
              <FolderOpen size={16} aria-hidden="true" />
              <span>Open</span>
            </button>
          </div>
          <div className="workspace-path" title={activeRepoPath}>
            {activeRepoPath}
          </div>
        </section>
      ) : null}

      {openPanel === "mission" ? (
        <section className="popover mission-popover" aria-label="New mission">
          <div className="section-label">Mission intake</div>
          <textarea
            aria-label="Mission intent"
            value={missionDraft}
            onChange={(event) => setMissionDraft(event.target.value)}
          />
          <button
            className="primary command-button"
            type="button"
            onClick={() => {
              void queueMission();
              setOpenPanel(null);
            }}
            disabled={!missionDraft.trim()}
          >
            <Rocket size={17} aria-hidden="true" />
            <span>Queue mission</span>
          </button>
        </section>
      ) : null}

      {missionLoopError ? <div className="floating-error">{missionLoopError}</div> : null}

      {selectedMission ? (
        <aside className="inspector" aria-label="Inspector">
          <section className="console-panel selected-console" aria-label="Selected node">
            <div className="panel-head">
              <div>
                <div className="section-label">Inspector</div>
                <h2>{selectedGraphNode?.label ?? ""}</h2>
              </div>
              <MissionGlyph status={statusFromRuntime(selectedRuntime)} />
            </div>
            <NodeInspector
              node={selectedGraphNode}
              mission={selectedMission}
              missions={workspaceMissions}
              repositories={missionLoopState.repositories}
              runtime={selectedRuntime}
            />
          </section>

          <section className="console-panel work-order-console" aria-label="Work order">
          <div className="panel-head">
            <div>
              <div className="section-label">Work order</div>
              <h2>{missionLabel(selectedMission.title)}</h2>
            </div>
            <div className={`mini-state ${missionStatus.className}`}>{missionStatus.label}</div>
          </div>
          <p className="mission-intent">{selectedMission.title}</p>
          <div className="work-order-meta">
            <span title={selectedRepository?.path ?? activeRepoPath}>
              <Network size={13} aria-hidden="true" />
              {selectedRepository?.name ?? "workspace"}
            </span>
            <span title={workerLimitation(selectedMission.worker)}>
              <RadioTower size={13} aria-hidden="true" />
              {workerLabel(selectedMission.worker)}
            </span>
            <span title={selectedVerificationCommand}>
              <Terminal size={13} aria-hidden="true" />
              {selectedVerificationCommand}
            </span>
          </div>
          <div className="worker-controls">
            <label>
              <span>Worker</span>
              <select
                aria-label="Worker mode"
                value={selectedWorkerMode}
                onChange={(event) =>
                  setWorkerModeByMission((current) => ({
                    ...current,
                    [selectedMission.id]: event.target.value as WorkerMode,
                  }))
                }
              >
                <option value="mock">Demo worker</option>
                <option value="local-command">Local command</option>
                <option value="claude-manager">Claude Manager (AI)</option>
              </select>
            </label>
            {selectedWorkerMode === "local-command" ? (
              <label>
                <span>Command</span>
                <textarea
                  className="local-command-input"
                  aria-label="Local worker command"
                  value={selectedLocalCommand}
                  onChange={(event) =>
                    setLocalCommandByMission((current) => ({
                      ...current,
                      [selectedMission.id]: event.target.value,
                    }))
                  }
                />
              </label>
            ) : null}
          </div>
          <div className="role-stack">
            {workOrderRoles(selectedRuntime, patchReady).map((role) => (
              <div className="role-row" key={role.name}>
                <span className={`role-light ${role.state}`} aria-hidden="true" />
                <UserCheck size={14} aria-hidden="true" />
                <div>
                  <strong>{role.name}</strong>
                  <small>{role.detail}</small>
                </div>
              </div>
            ))}
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
              onClick={selectedRuntime.step < 0 ? startMission : advanceStep}
              disabled={selectedRuntime.status === "running" || (patchReady && selectedRuntime.patchStatus !== "pending")}
              aria-label="Advance run"
              title="Advance run"
            >
              <Play size={16} aria-hidden="true" />
            </button>
          </div>
          <ol className="activity-list">
            {activity.length === 0 ? <li className="quiet">Mission is queued outside the active lane.</li> : null}
            {activity.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>
        </section>

        <section className="console-panel patch-console" aria-label="Patch">
          <div className="panel-head">
            <div>
              <div className="section-label">CEO gate</div>
              <h2>Patch approval</h2>
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
              <span>Approve + apply</span>
            </button>
          </div>
        </section>

        <section className="console-panel verify-console" aria-label="Verification">
          <div className="panel-head">
            <div>
              <div className="section-label">QA</div>
              <h2>Verification gate</h2>
            </div>
            <button
              className="secondary icon-button"
              type="button"
              disabled={selectedRuntime.patchStatus !== "approved" || selectedRuntime.verified || !selectedVerificationCommand.trim()}
              onClick={runVerification}
              aria-label="Run verification"
              title="Run verification"
            >
              <Terminal size={16} aria-hidden="true" />
            </button>
          </div>
          <input
            className="command-line"
            aria-label="Verification command"
            value={selectedVerificationCommand}
            onChange={(event) =>
              setVerificationCommandByMission((current) => ({
                ...current,
                [selectedMission.id]: event.target.value,
              }))
            }
          />
          <pre className="test-output">{verificationOutput(selectedRuntime, selectedVerificationOutput)}</pre>
          </section>
        </aside>
      ) : null}

      {workspaceMissions.length === 0 ? (
        <div className="canvas-hint">
          <p>Open a workspace, then queue a mission to begin.</p>
        </div>
      ) : null}
    </main>
  );
}

function repoLabel(name: string | undefined, path: string) {
  if (name) {
    return name;
  }
  const trimmed = path.replace(/\/+$/, "");
  const base = trimmed.split("/").filter(Boolean).at(-1);
  return base || "Open repo";
}

function MissionGlyph({ status }: { status: MissionNodeStatus }) {
  const Icon = status === "verified" ? ShieldCheck : status === "review" || status === "approved" ? Zap : RadioTower;

  return (
    <span className={`mission-glyph ${status}`}>
      <Icon size={15} aria-hidden="true" />
    </span>
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
          {node.label}
        </span>
        <span>
          <Network size={14} aria-hidden="true" />
          assigned to {mission.title}
        </span>
        <span>
          <Terminal size={14} aria-hidden="true" />
          {node.detail}
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

function nearestMissionId(node: WorkspaceGraphNode | undefined, missions: WorkspaceMission[]) {
  if (!node) return undefined;
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
  if (runtime.status === "blocked") {
    return "blocked";
  }
  if (runtime.status === "verified") {
    return "verified";
  }
  if (runtime.verified) {
    return "verified";
  }
  if (runtime.patchStatus === "approved") {
    return "approved";
  }
  if (runtime.patchStatus === "rejected") {
    return "blocked";
  }
  if (runtime.status === "review") {
    return "review";
  }
  if (runtime.step >= 0) {
    return "running";
  }
  if (runtime.status === "queued") {
    return "queued";
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

function workerLabel(workerName: string) {
  if (workerName === "mock") {
    return "Demo worker: limited patch generator";
  }
  if (workerName === "claude-manager") {
    return "Claude Manager: AI orchestrates child agents";
  }
  if (workerName === "claude-engineer") {
    return "Claude Engineer: AI code generation agent";
  }
  if (workerName === "unassigned") {
    return "Worker not assigned";
  }

  return workerName;
}

function workerLimitation(workerName: string) {
  if (workerName === "mock") {
    return "Supports the demo Node CLI patch path while the real local worker interface is being built.";
  }
  if (workerName === "claude-manager") {
    return "Requires the claude CLI on PATH. Decomposes the mission, then runs a Claude Engineer and a Claude Reviewer in sequence on the same tree.";
  }
  if (workerName === "unassigned") {
    return "Dispatch the mission to assign a worker.";
  }

  return workerName;
}

function defaultLocalCommand() {
  return `printf 'diff --git a/orbital-local-worker.txt b/orbital-local-worker.txt\nnew file mode 100644\n--- /dev/null\n+++ b/orbital-local-worker.txt\n@@ -0,0 +1 @@\n+local worker completed\n' > "$ORBITAL_PATCH_PATH"`;
}

function workOrderRoles(runtime: WorkspaceRuntime, patchReady: boolean) {
  return [
    {
      name: "AI Manager",
      detail: runtime.step >= 0 ? "Mission dispatched to the floor." : "Waiting for launch order.",
      state: runtime.step >= 0 ? "done" : "idle",
    },
    {
      name: "Architect",
      detail: runtime.step >= 2 ? "Repository context mapped." : runtime.step >= 1 ? "Reading system context." : "Queued for intake.",
      state: runtime.step >= 2 ? "done" : runtime.step >= 1 ? "active" : "idle",
    },
    {
      name: "Engineer",
      detail: patchReady ? "Patch delivered to CEO gate." : runtime.step >= 3 ? "Building proposed change." : "Waiting for architecture.",
      state: patchReady ? "done" : runtime.step >= 3 ? "active" : "idle",
    },
    {
      name: "QA",
      detail: runtime.verified
        ? "Verification passed."
        : runtime.status === "blocked"
          ? "Mission blocked at QA or approval."
        : runtime.patchStatus === "approved"
          ? "Ready to run verification."
          : runtime.patchStatus === "rejected"
            ? "Mission stopped before QA."
            : "Waiting for CEO approval.",
      state: runtime.verified
        ? "done"
        : runtime.status === "blocked" || runtime.patchStatus === "rejected"
          ? "blocked"
          : runtime.patchStatus === "approved"
            ? "active"
            : "idle",
    },
  ];
}

function verificationOutput(runtime: WorkspaceRuntime, output: string) {
  if (runtime.verified) {
    return output || "Verification passed.";
  }
  if (runtime.status === "blocked") {
    return output || "Mission blocked before verification completed.";
  }
  if (runtime.patchStatus === "approved") {
    return "Patch approved. Verification command is armed.";
  }
  if (runtime.patchStatus === "rejected") {
    return "Patch rejected. Mission stopped before file changes.";
  }
  return "Waiting for approved patch.";
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallback;
}
