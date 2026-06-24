import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  CircleDot,
  Gauge,
  Network,
  Play,
  RadioTower,
  RefreshCw,
  Rocket,
  Terminal,
  FolderOpen,
  X,
} from "lucide-react";
import { GraphMap } from "./components/GraphMap";
import { DiffView } from "./components/DiffView";
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

// Map a mission's actual worker name to the selectable mode, so the per-mission
// dropdown reflects whoever last ran it (any claude-* agent reads as Claude).
function workerModeFromName(workerName: string | undefined): WorkerMode {
  if (workerName === "local-command") return "local-command";
  if (workerName?.startsWith("claude")) return "claude-manager";
  return "mock";
}

function workerModeLabel(mode: WorkerMode): string {
  if (mode === "local-command") return "Local cmd";
  if (mode === "claude-manager") return "Claude AI";
  return "Demo worker";
}

// Merge every open repository's state into one MissionLoopState. The adapter
// already keys nodes by repository_id / mission_id, so the union renders each
// repo as its own cluster on the shared canvas.
function combineRepoStates(states: Record<string, MissionLoopState>): MissionLoopState {
  const all = Object.values(states);
  return {
    repositories: all.flatMap((state) => state.repositories),
    missions: all.flatMap((state) => state.missions),
    agent_runs: all.flatMap((state) => state.agent_runs),
    workflow_events: all.flatMap((state) => state.workflow_events),
    patch_proposals: all.flatMap((state) => state.patch_proposals),
    verification_runs: all.flatMap((state) => state.verification_runs),
  };
}

// Normalize a loaded state into one slice per repository, keyed by repo id. The
// worker returns a single repo per call, but the browser fixture bundles
// several — splitting lets each repo be added, updated, or closed on its own.
function splitByRepository(state: MissionLoopState): Record<string, MissionLoopState> {
  const out: Record<string, MissionLoopState> = {};
  for (const repo of state.repositories) {
    const missionIds = new Set(state.missions.filter((mission) => mission.repository_id === repo.id).map((mission) => mission.id));
    const runIds = new Set(state.agent_runs.filter((run) => missionIds.has(run.mission_id)).map((run) => run.id));
    out[repo.id] = {
      repositories: [repo],
      missions: state.missions.filter((mission) => mission.repository_id === repo.id),
      agent_runs: state.agent_runs.filter((run) => missionIds.has(run.mission_id)),
      workflow_events: state.workflow_events.filter(
        (event) => (event.mission_id != null && missionIds.has(event.mission_id)) || (event.run_id != null && runIds.has(event.run_id)),
      ),
      patch_proposals: state.patch_proposals.filter((patch) => runIds.has(patch.run_id)),
      verification_runs: state.verification_runs.filter((run) => run.repository_id === repo.id || missionIds.has(run.mission_id)),
    };
  }
  return out;
}

export function App() {
  const [missionLoopState, setMissionLoopState] = useState(emptyMissionLoopState);
  // Each opened repository keeps its own worker state; the canvas renders the
  // union of them all. Keyed by repository id.
  const repoStatesRef = useRef<Record<string, MissionLoopState>>({});
  const [refreshingMissionLoop, setRefreshingMissionLoop] = useState(false);
  const [missionLoopError, setMissionLoopError] = useState("");
  const [repoPathDraft, setRepoPathDraft] = useState(demoRepoPath);
  const [activeRepoPath, setActiveRepoPath] = useState(demoRepoPath);
  const [selectedNodeId, setSelectedNodeId] = useState("mission_version");
  const [missionDraft, setMissionDraft] = useState("stabilize the release path");
  // Repos a queued intent fans out to. Picking >1 makes it a coordinated
  // campaign: the same intent is queued in each repo under a shared campaign id.
  const [campaignRepoIds, setCampaignRepoIds] = useState<string[]>([]);
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
    Object.fromEntries(initialWorkspaceView.missions.map((mission) => [mission.id, workerModeFromName(mission.worker)])),
  );
  const [localCommandByMission, setLocalCommandByMission] = useState<Record<string, string>>({});
  const [openPanel, setOpenPanel] = useState<null | "repo" | "mission" | "control">(null);
  const togglePanel = (panel: "repo" | "mission" | "control") =>
    setOpenPanel((current) => {
      const next = current === panel ? null : panel;
      // Opening intake starts from the current repo; campaign targets are opt-in.
      if (next === "mission") setCampaignRepoIds([]);
      return next;
    });

  const selectedGraphNode = workspaceGraphNodes.find((node) => node.id === selectedNodeId) ?? workspaceGraphNodes[0];
  const selectedMissionId = selectedGraphNode?.mission_id ?? nearestMissionId(selectedGraphNode, workspaceMissions) ?? workspaceMissions[0]?.id;
  const selectedMission = workspaceMissions.find((mission) => mission.id === selectedMissionId) ?? workspaceMissions[0];
  const selectedRepository = selectedMission ? repositoryFor(selectedMission, missionLoopState.repositories) : undefined;
  const selectedRuntime = (selectedMission ? runtimeByMission[selectedMission.id] : undefined) ?? { step: -1, patchStatus: "pending" as const, verified: false, status: "queued" as const };
  const selectedPatchDiff = (selectedMission ? patchDiffByMission[selectedMission.id] : undefined) ?? "";
  const selectedVerificationOutput = (selectedMission ? verificationOutputByMission[selectedMission.id] : undefined) ?? "";
  const selectedVerificationCommand = (selectedMission ? verificationCommandByMission[selectedMission.id] : undefined) ?? selectedMission?.command ?? "";
  const selectedWorkerMode = (selectedMission ? workerModeByMission[selectedMission.id] : undefined) ?? workerModeFromName(selectedMission?.worker);
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
      workspaceGraphNodes.map((node) => {
        const runtime = node.mission_id ? runtimeByMission[node.mission_id] : undefined;
        const status = runtime ? statusFromRuntime(runtime) : undefined;
        // Surface each mission's assigned worker on its node so the per-mission
        // choice is visible on the canvas (blocked missions keep their warning).
        if (node.kind === "mission" && node.mission_id && status !== "blocked") {
          return { ...node, status, detail: workerModeLabel(workerModeByMission[node.mission_id] ?? "mock") };
        }
        return { ...node, status };
      }),
    [runtimeByMission, workspaceGraphNodes, workerModeByMission],
  );

  const graphEdges = workspaceGraphEdges;

  const runningMissionIds = useMemo(
    () => new Set(workspaceMissions.filter((m) => runtimeByMission[m.id]?.status === "running").map((m) => m.id)),
    [workspaceMissions, runtimeByMission],
  );

  const missionAwaitsApproval = (missionId: string) =>
    (patchDiffByMission[missionId] ?? "") !== "" && runtimeByMission[missionId]?.patchStatus === "pending";
  const missionIsLaunchable = (missionId: string) => {
    const status = runtimeByMission[missionId]?.status;
    return status === undefined || status === "queued" || status === "draft";
  };
  const pendingApprovalCount = workspaceMissions.filter((m) => missionAwaitsApproval(m.id)).length;
  const launchableCount = workspaceMissions.filter((m) => missionIsLaunchable(m.id)).length;

  const updateSelectedRuntime = (next: (runtime: WorkspaceRuntime) => WorkspaceRuntime) => {
    setRuntimeByMission((current) => ({
      ...current,
      [selectedMission.id]: next(current[selectedMission.id]),
    }));
  };

  const repoPathForMission = (missionId: string) => {
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const repository = mission ? missionLoopState.repositories.find((repo) => repo.id === mission.repository_id) : undefined;
    return repository?.path ?? activeRepoPath;
  };

  const startMission = () => dispatchMission(selectedMission.id);

  // Launch every draft/queued mission at once. Each runs in its own worker
  // process and git worktree, so the backlog burns down in parallel.
  const launchAllMissions = () => {
    const pending = workspaceMissions.filter((mission) => {
      const status = runtimeByMission[mission.id]?.status;
      return status === undefined || status === "queued" || status === "draft";
    });
    pending.forEach((mission) => void dispatchMission(mission.id));
  };

  // dispatchMission starts one mission by id, independent of the current
  // selection, so several can be fired concurrently.
  const dispatchMission = async (missionId: string) => {
    setMissionLoopError("");
    const repoPath = repoPathForMission(missionId);
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const workerMode = workerModeByMission[missionId] ?? workerModeFromName(mission?.worker);
    const localCommand = localCommandByMission[missionId] ?? defaultLocalCommand();

    // Optimistically mark it running so the canvas pulses immediately.
    setRuntimeByMission((current) => ({
      ...current,
      [missionId]: { ...(current[missionId] ?? { step: -1, patchStatus: "pending", verified: false, status: "queued" }), status: "running", step: Math.max(current[missionId]?.step ?? -1, 0) },
    }));

    let unlistenEvent: (() => void) | undefined;
    let unlistenPatch: (() => void) | undefined;

    if (isTauriRuntime()) {
      unlistenEvent = await listen<WorkflowEvent>("workflow_event", (e) => {
        const event = e.payload;
        // Parallel runs share one event channel; keep each mission's stream its own.
        if (event.mission_id && event.mission_id !== missionId) return;
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
      const nextMissionLoopState = await startAgentRunMissionLoopState(
        repoPath,
        missionId,
        workerMode,
        workerMode === "local-command" ? localCommand : undefined,
      );
      if (nextMissionLoopState) {
        applyRepoState(nextMissionLoopState, missionId);
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
  };

  // Queue a backlog: one mission per non-empty line, so several can be lined up
  // at once and then launched in parallel.
  const queueMission = async () => {
    const titles = missionDraft.split("\n").map((line) => line.trim()).filter(Boolean);
    if (titles.length === 0) {
      return;
    }

    setMissionLoopError("");

    // Resolve which repos this intent targets. >1 → a coordinated campaign:
    // every target gets the same intent under a shared campaign id.
    const targetRepos = campaignTargetRepos();
    const isCampaign = targetRepos.length > 1;

    if (isTauriRuntime()) {
      try {
        let lastMissionId: string | undefined;
        for (let titleIndex = 0; titleIndex < titles.length; titleIndex++) {
          const title = titles[titleIndex];
          const campaignId = isCampaign ? `camp_${Date.now()}_${titleIndex}` : undefined;
          for (const repo of targetRepos) {
            const nextMissionLoopState = await queueMissionLoopState(repo.path, title, campaignId);
            if (nextMissionLoopState) {
              lastMissionId = nextMissionLoopState.missions.at(-1)?.id;
              applyRepoState(nextMissionLoopState, lastMissionId);
            }
          }
        }
      } catch (error) {
        setMissionLoopError(errorMessage(error, "Failed to queue mission."));
      }
      return;
    }

    // Browser demo: optimistic local missions, with an explicit campaign node
    // when the intent fans out across more than one repo.
    titles.forEach((title, titleIndex) => {
      const campaignId = isCampaign ? `camp_${Date.now()}_${titleIndex}` : undefined;
      const missionIds = targetRepos.map((repo, repoIndex) =>
        addLocalMission(title, titleIndex * targetRepos.length + repoIndex, repo.id),
      );
      if (campaignId && missionIds.length > 1) {
        addLocalCampaign(campaignId, title, missionIds);
      }
    });
  };

  // Repos a queued intent fans out to: the explicit campaign selection if any,
  // otherwise just the currently selected repo.
  const campaignTargetRepos = () => {
    const repositories = missionLoopState.repositories;
    if (campaignRepoIds.length > 0) {
      return campaignRepoIds
        .map((id) => repositories.find((repo) => repo.id === id))
        .filter((repo): repo is Repository => Boolean(repo));
    }
    if (selectedRepository) return [selectedRepository];
    const active = repositories.find((repo) => repo.path === activeRepoPath);
    return active ? [active] : [];
  };

  const toggleCampaignRepo = (repoId: string) => {
    setCampaignRepoIds((current) => {
      const base = current.length > 0 ? current : campaignTargetRepos().map((repo) => repo.id);
      return base.includes(repoId) ? base.filter((id) => id !== repoId) : [...base, repoId];
    });
  };

  // Optimistic, non-Tauri-only mission so the browser demo can line up a backlog.
  // Returns the new mission id so a campaign fan-out can tie the lanes together.
  const addLocalMission = (title: string, offset: number, repositoryId: string): string => {
    const missionId = `mission_${Date.now()}_${offset}`;
    const targetRepositoryId = repositoryId;
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
      y: 0,
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
      [missionId]: { step: mission.step, patchStatus: mission.patch_status, verified: mission.verified, status: mission.status },
    }));
    setPatchDiffByMission((current) => ({ ...current, [missionId]: "" }));
    setVerificationOutputByMission((current) => ({ ...current, [missionId]: "" }));
    setActivityByMission((current) => ({ ...current, [missionId]: [] }));
    setWorkerModeByMission((current) => ({ ...current, [missionId]: selectedWorkerMode }));
    setSelectedNodeId(missionId);
    return missionId;
  };

  // Optimistic campaign node + fan-out edges for the browser demo, so a
  // coordinated multi-repo launch reads as one campaign without a worker round-trip.
  const addLocalCampaign = (campaignId: string, title: string, missionIds: string[]) => {
    const campaignNodeId = `campaign:${campaignId}`;
    const campaignNode: WorkspaceGraphNode = {
      id: campaignNodeId,
      kind: "campaign",
      label: missionLabel(title),
      detail: `${missionIds.length} repos · 0/${missionIds.length} landed`,
      x: 4,
      y: 12,
      mission_id: campaignNodeId,
    };
    const edges: WorkspaceGraphEdge[] = missionIds.map((missionId) => ({
      id: `campaign_${campaignId}_${missionId}`,
      from: campaignNodeId,
      to: missionId,
      kind: "coordinates",
    }));
    setWorkspaceGraphNodes((current) => [...current, campaignNode]);
    setWorkspaceGraphEdges((current) => [...current, ...edges]);
  };

  const advanceStep = () => {
    updateSelectedRuntime((current) => ({
      ...current,
      step: current.step + 1,
    }));
  };

  const setMissionRuntime = (missionId: string, next: (runtime: WorkspaceRuntime) => WorkspaceRuntime) => {
    setRuntimeByMission((current) => ({
      ...current,
      [missionId]: next(current[missionId] ?? { step: -1, patchStatus: "pending", verified: false, status: "queued" }),
    }));
  };

  const approvePatch = () => approveMission(selectedMission.id);
  const rejectPatch = () => rejectMission(selectedMission.id);

  const approveMission = async (missionId: string) => {
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await approvePatchMissionLoopState(repoPathForMission(missionId), missionId);
      if (nextMissionLoopState) {
        applyRepoState(nextMissionLoopState, missionId);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to approve patch."));
      return;
    }

    setMissionRuntime(missionId, (current) => ({ ...current, patchStatus: "approved", status: "approved" }));
  };

  const rejectMission = async (missionId: string) => {
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await rejectPatchMissionLoopState(repoPathForMission(missionId), missionId);
      if (nextMissionLoopState) {
        applyRepoState(nextMissionLoopState, missionId);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to reject patch."));
      return;
    }

    setMissionRuntime(missionId, (current) => ({ ...current, patchStatus: "rejected", status: "blocked" }));
  };

  const runVerification = async () => {
    const command = selectedVerificationCommand.trim();
    if (!command) {
      setMissionLoopError("Verification command is required.");
      return;
    }

    setMissionLoopError("");

    try {
      const repoPath = selectedRepository?.path ?? activeRepoPath;
      const nextMissionLoopState = await verifyMissionLoopState(repoPath, selectedMission.id, command);
      if (nextMissionLoopState) {
        applyRepoState(nextMissionLoopState, selectedMission.id);
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
        nextWorkspaceView.missions.map((mission) => [mission.id, current[mission.id] ?? workerModeFromName(mission.worker)]),
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

  // applyRepoState folds a loaded state (one repo from the worker, or several
  // from the fixture) into the open set keyed by repo id, then re-hydrates the
  // canvas from the union — so adding or updating a repo keeps the others.
  const applyRepoState = (state: MissionLoopState, preferredNodeId?: string) => {
    const next = { ...repoStatesRef.current, ...splitByRepository(state) };
    repoStatesRef.current = next;
    hydrateMissionLoop(combineRepoStates(next), preferredNodeId);
  };

  const closeRepo = (repositoryId: string) => {
    const { [repositoryId]: _removed, ...next } = repoStatesRef.current;
    repoStatesRef.current = next;
    hydrateMissionLoop(combineRepoStates(next));
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
        applyRepoState(nextMissionLoopState, nextMissionLoopState.repositories[0]?.id);
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
        applyRepoState(nextMissionLoopState, nextMissionLoopState.repositories[0]?.id);
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
      applyRepoState(activeRepoPath === demoRepoPath ? await refreshMissionLoopState() : await loadMissionLoopState(activeRepoPath));
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
        applyRepoState(await loadMissionLoopState(activeRepoPath));
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
        edges={graphEdges}
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
            className={`chip ${openPanel === "control" ? "active" : ""}`}
            type="button"
            onClick={() => togglePanel("control")}
            title="Mission control"
          >
            <Gauge size={15} aria-hidden="true" />
            <span>Control</span>
            {pendingApprovalCount > 0 ? <span className="chip-badge">{pendingApprovalCount}</span> : null}
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
              <span>Add</span>
            </button>
          </div>
          {missionLoopState.repositories.length > 0 ? (
            <ul className="workspace-repos">
              {missionLoopState.repositories.map((repo) => (
                <li key={repo.id}>
                  <Network size={14} aria-hidden="true" />
                  <span className="workspace-repo-name" title={repo.path}>{repo.name}</span>
                  <button
                    className="repo-close"
                    type="button"
                    onClick={() => closeRepo(repo.id)}
                    title="Close repository"
                    aria-label={`Close ${repo.name}`}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {openPanel === "mission" ? (
        <section className="popover mission-popover" aria-label="New mission">
          <div className="section-label">Mission intake</div>
          <textarea
            aria-label="Mission intent"
            placeholder={"One mission per line — queue a whole backlog at once.\nadd a healthcheck endpoint\nupgrade the logging library\n…"}
            value={missionDraft}
            onChange={(event) => setMissionDraft(event.target.value)}
          />
          {missionLoopState.repositories.length > 1 ? (
            <div className="campaign-targets">
              <div className="section-label">Target repos {campaignTargetRepos().length > 1 ? "· campaign" : ""}</div>
              <ul className="campaign-repo-list">
                {missionLoopState.repositories.map((repo) => {
                  const checked = campaignTargetRepos().some((target) => target.id === repo.id);
                  return (
                    <li key={repo.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCampaignRepo(repo.id)}
                        />
                        <span>{repo.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
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
            <span>
              {campaignTargetRepos().length > 1
                ? `Launch campaign · ${campaignTargetRepos().length} repos`
                : `Queue ${missionDraft.split("\n").filter((line) => line.trim()).length > 1 ? "backlog" : "mission"}`}
            </span>
          </button>
        </section>
      ) : null}

      {openPanel === "control" ? (
        <section className="popover control-popover" aria-label="Mission control">
          <div className="control-head">
            <div>
              <div className="section-label">Mission control</div>
              <h2>Backlog &amp; triage</h2>
            </div>
            <button
              className="primary"
              type="button"
              onClick={launchAllMissions}
              disabled={launchableCount === 0}
              title="Launch every queued mission in parallel"
            >
              <Rocket size={15} aria-hidden="true" />
              <span>Launch all{launchableCount > 0 ? ` (${launchableCount})` : ""}</span>
            </button>
          </div>
          <ul className="control-list">
            {workspaceMissions.length === 0 ? <li className="quiet">No missions yet — queue some from Mission.</li> : null}
            {workspaceMissions.map((mission) => {
              const runtime = runtimeByMission[mission.id];
              const status = runtime ? statusFromRuntime(runtime) : undefined;
              const repo = missionLoopState.repositories.find((item) => item.id === mission.repository_id);
              return (
                <li key={mission.id} className={mission.id === selectedMission?.id ? "selected" : ""}>
                  <button type="button" className="control-row" onClick={() => setSelectedNodeId(mission.id)}>
                    <span className={`status-dot ${status ?? ""}`} aria-hidden="true" />
                    <span className="control-title">{mission.title}</span>
                    <span className="control-repo">{repo?.name}</span>
                  </button>
                  <div className="control-actions">
                    {missionAwaitsApproval(mission.id) ? (
                      <>
                        <button className="secondary mini" type="button" onClick={() => void rejectMission(mission.id)} title="Reject">
                          <X size={14} aria-hidden="true" />
                        </button>
                        <button className="primary mini" type="button" onClick={() => void approveMission(mission.id)} title="Approve + apply">
                          <Check size={14} aria-hidden="true" />
                        </button>
                      </>
                    ) : missionIsLaunchable(mission.id) ? (
                      <button className="primary mini" type="button" onClick={() => void dispatchMission(mission.id)} title="Launch">
                        <Play size={14} aria-hidden="true" />
                      </button>
                    ) : (
                      <span className={`control-state ${status ?? ""}`}>{controlStateLabel(status)}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {missionLoopError ? <div className="floating-error">{missionLoopError}</div> : null}

      {selectedMission ? (
        <aside className="inspector" aria-label="Inspector">
          <section className="console-panel work-order-console" aria-label="Work order">
          <div className="panel-head">
            <div>
              <div className="section-label">Work order</div>
              <h2 className="work-order-title">{selectedMission.title}</h2>
            </div>
            <div className={`mini-state ${missionStatus.className}`}>{missionStatus.label}</div>
          </div>
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
          <DiffView
            diff={patchReady ? selectedPatchDiff : ""}
            emptyLabel={
              patchReady
                ? "No patch proposal captured for this mission."
                : "Patch stream locked until this mission reaches review."
            }
          />
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

function controlStateLabel(status: MissionNodeStatus | undefined): string {
  switch (status) {
    case "running":
      return "Running";
    case "review":
      return "In review";
    case "approved":
      return "Approved";
    case "verified":
      return "Verified";
    case "blocked":
      return "Blocked";
    default:
      return "Idle";
  }
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
