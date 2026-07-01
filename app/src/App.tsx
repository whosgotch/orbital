import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  CircleDot,
  Gauge,
  Maximize2,
  Network,
  Pencil,
  Play,
  RadioTower,
  RefreshCw,
  Rocket,
  Terminal,
  Trash2,
  FolderOpen,
  X,
} from "lucide-react";
import { GraphMap } from "./components/GraphMap";
import { DiffView } from "./components/DiffView";
import { type TranscriptEntry } from "./components/AgentTranscript";
import { AgentChat } from "./components/AgentChat";
import { buildAgentStatus } from "./agentStatus";
import {
  type MissionNodeStatus,
  type WorkspaceGraphEdge,
  type WorkspaceGraphNode,
  type WorkspaceMission,
} from "./mockMission";
import type { ChatMessage, MissionLoopState, PatchProposal, Repository, WorkflowEvent } from "./domain";
import {
  roleLabel,
  workspaceViewFromMissionLoop,
  type WorkspaceRuntime,
  type WorkspaceRuntimeMap,
} from "./workspaceAdapter";
import {
  approvePatchMissionLoopState,
  deleteMissionLoopState,
  demoRepoPath,
  isTauriRuntime,
  loadMissionLoopState,
  openMissionLoopRepository,
  queueMissionLoopState,
  rejectPatchMissionLoopState,
  refreshMissionLoopState,
  sendAgentMessageLoopState,
  startAgentRunMissionLoopState,
  updateMissionTextLoopState,
  verifyMissionLoopState,
} from "./missionLoopLoader";

const emptyMissionLoopState: MissionLoopState = {
  repositories: [],
  missions: [],
  agent_runs: [],
  workflow_events: [],
  patch_proposals: [],
  verification_runs: [],
  chat_messages: [],
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
    chat_messages: all.flatMap((state) => state.chat_messages),
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
      chat_messages: state.chat_messages.filter((message) => missionIds.has(message.mission_id) || runIds.has(message.run_id)),
    };
  }
  return out;
}

// Drop a mission and everything attached to it from a combined state. Mirrors
// the worker's DeleteMission cascade for the browser/demo path that has no
// backend to do it.
function removeMissionFromState(state: MissionLoopState, missionId: string): MissionLoopState {
  const runIds = new Set(state.agent_runs.filter((run) => run.mission_id === missionId).map((run) => run.id));
  return {
    repositories: state.repositories,
    missions: state.missions.filter((mission) => mission.id !== missionId),
    agent_runs: state.agent_runs.filter((run) => run.mission_id !== missionId),
    workflow_events: state.workflow_events.filter(
      (event) => event.mission_id !== missionId && !(event.run_id != null && runIds.has(event.run_id)),
    ),
    patch_proposals: state.patch_proposals.filter((patch) => !runIds.has(patch.run_id)),
    verification_runs: state.verification_runs.filter((run) => run.mission_id !== missionId),
    chat_messages: state.chat_messages.filter((message) => message.mission_id !== missionId && !runIds.has(message.run_id)),
  };
}

export function App() {
  const [missionLoopState, setMissionLoopState] = useState(emptyMissionLoopState);
  // Each opened repository keeps its own worker state; the canvas renders the
  // union of them all. Keyed by repository id.
  const repoStatesRef = useRef<Record<string, MissionLoopState>>({});
  // Missions whose in-flight run we intentionally killed (via delete). Their
  // dispatch promise rejects when the agent process dies — we swallow that
  // instead of flashing it as an error.
  const cancelledMissionsRef = useRef<Set<string>>(new Set());
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
  // Review panel: which tab is shown and whether the verification log is expanded.
  const [reviewTab, setReviewTab] = useState<"changes" | "activity" | "chat">("changes");
  // The live conversation with each mission's agent, and which missions have a
  // chat turn in flight (so the composer shows a spinner while the agent works).
  const [chatByMission, setChatByMission] = useState<Record<string, ChatMessage[]>>({});
  const [chatSendingByMission, setChatSendingByMission] = useState<Record<string, boolean>>({});
  const [verifyOpen, setVerifyOpen] = useState(false);
  // Whether the diff is popped out into a wide full-screen modal.
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  // File path to focus in the diff when a file node is clicked.
  const [focusedDiffFile, setFocusedDiffFile] = useState<string | undefined>(undefined);
  // Worker chosen at launch time (intake), applied to every mission queued.
  const [intakeWorkerMode, setIntakeWorkerMode] = useState<WorkerMode>("claude-manager");
  // Inline prompt editor for refining a mission's instruction before launch.
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [openPanel, setOpenPanel] = useState<null | "repo" | "mission" | "control">(null);
  const togglePanel = (panel: "repo" | "mission" | "control") =>
    setOpenPanel((current) => {
      const next = current === panel ? null : panel;
      // Opening intake starts from the current repo; campaign targets are opt-in.
      if (next === "mission") setCampaignRepoIds([]);
      return next;
    });

  // Selecting a node also deep-links into the relevant review section, so each
  // node does something specific instead of just opening the same panel.
  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = workspaceGraphNodes.find((item) => item.id === nodeId);
    if (!node) return;
    switch (node.kind) {
      case "patch":
        setReviewTab("changes");
        break;
      case "verification":
      case "test":
        setReviewTab("changes");
        setVerifyOpen(true);
        break;
      case "file":
        setReviewTab("changes");
        setFocusedDiffFile(node.label);
        break;
      case "worker":
        setReviewTab("chat");
        break;
      default:
        break;
    }
  };

  const selectedGraphNode = workspaceGraphNodes.find((node) => node.id === selectedNodeId) ?? workspaceGraphNodes[0];
  const selectedMissionId = selectedGraphNode?.mission_id ?? nearestMissionId(selectedGraphNode, workspaceMissions) ?? workspaceMissions[0]?.id;
  const selectedMission = workspaceMissions.find((mission) => mission.id === selectedMissionId) ?? workspaceMissions[0];
  // The raw mission record carries the full prompt text — the WorkspaceMission's
  // title is only the short node label.
  const selectedMissionRecord = missionLoopState.missions.find((mission) => mission.id === selectedMission?.id);
  const selectedRepository = selectedMission ? repositoryFor(selectedMission, missionLoopState.repositories) : undefined;
  const selectedRuntime = (selectedMission ? runtimeByMission[selectedMission.id] : undefined) ?? { step: -1, patchStatus: "pending" as const, verified: false, status: "queued" as const };
  const selectedPatchDiff = (selectedMission ? patchDiffByMission[selectedMission.id] : undefined) ?? "";
  const selectedVerificationOutput = (selectedMission ? verificationOutputByMission[selectedMission.id] : undefined) ?? "";
  const selectedVerificationCommand = (selectedMission ? verificationCommandByMission[selectedMission.id] : undefined) ?? selectedMission?.command ?? "";
  const patchReady = (selectedPatchDiff ?? "") !== "";

  // The agent run the transcript is scoped to: a clicked child agent uses its own
  // run id; the manager node uses the mission's top-level run; otherwise the
  // whole mission's agents are shown together.
  const selectedAgentRunId = useMemo(() => {
    if (!selectedGraphNode || selectedGraphNode.kind !== "worker") return undefined;
    if (selectedGraphNode.id.endsWith("_manager")) {
      return missionLoopState.agent_runs.filter((run) => run.mission_id === selectedMissionId && !run.parent_run_id).at(-1)?.id;
    }
    return selectedGraphNode.id;
  }, [selectedGraphNode, missionLoopState.agent_runs, selectedMissionId]);

  const agentTranscript = useMemo(
    () => buildAgentTranscript(missionLoopState, selectedMissionId, selectedAgentRunId),
    [missionLoopState, selectedMissionId, selectedAgentRunId],
  );
  const selectedActivity = activityByMission[selectedMission?.id ?? ""] ?? [];
  const agentStatus = useMemo(
    () => buildAgentStatus(missionLoopState, selectedMissionId, selectedPatchDiff, selectedActivity, selectedRuntime),
    [missionLoopState, selectedMissionId, selectedPatchDiff, selectedActivity, selectedRuntime],
  );
  const activity = selectedActivity.slice(0, selectedRuntime.step + 1);
  const missionStatus = missionStatusFor(selectedRuntime, patchReady);
  const selectedChatMessages = chatByMission[selectedMission?.id ?? ""] ?? [];
  const selectedChatSending = chatSendingByMission[selectedMission?.id ?? ""] ?? false;

  // Close the inline prompt editor whenever the selected node changes, so an
  // unsaved draft never leaks onto a different mission.
  useEffect(() => {
    setEditingPrompt(false);
  }, [selectedMissionId]);

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
      // A delete kills the run mid-flight, which rejects here — that's expected,
      // not a failure to surface.
      if (cancelledMissionsRef.current.has(missionId)) {
        return;
      }
      console.error("[orbital] dispatch failed", error);
      setMissionLoopError(errorMessage(error, "Failed to dispatch mission."));
      return;
    } finally {
      unlistenEvent?.();
      unlistenPatch?.();
    }
  };

  // Send one chat turn to a mission's agent. The first turn starts a live
  // claude session; every later turn resumes it, so the agent keeps its context
  // and its diff evolves in place. Events stream in while the agent works.
  const sendAgentChat = async (missionId: string, text: string) => {
    setMissionLoopError("");
    const repoPath = repoPathForMission(missionId);

    // Show the user's turn immediately; the agent's reply and the authoritative
    // history land as the turn streams and completes.
    const optimistic: ChatMessage = {
      id: `local_${Date.now()}`,
      mission_id: missionId,
      run_id: "",
      role: "user",
      text,
      created_at: new Date().toISOString(),
    };
    setChatByMission((current) => ({
      ...current,
      [missionId]: [...(current[missionId] ?? []), optimistic],
    }));
    setChatSendingByMission((current) => ({ ...current, [missionId]: true }));
    setRuntimeByMission((current) => ({
      ...current,
      [missionId]: { ...(current[missionId] ?? { step: -1, patchStatus: "pending", verified: false, status: "queued" }), status: "running", step: Math.max(current[missionId]?.step ?? -1, 0) },
    }));

    let unlistenEvent: (() => void) | undefined;
    let unlistenPatch: (() => void) | undefined;
    let unlistenChat: (() => void) | undefined;

    if (isTauriRuntime()) {
      unlistenChat = await listen<ChatMessage>("chat_message", (e) => {
        const message = e.payload;
        // The user turn is already shown optimistically; only stream the reply.
        if (message.mission_id !== missionId || message.role !== "assistant") return;
        setChatByMission((current) => {
          const existing = current[missionId] ?? [];
          if (existing.some((item) => item.id === message.id)) return current;
          return { ...current, [missionId]: [...existing, message] };
        });
      });

      unlistenEvent = await listen<WorkflowEvent>("workflow_event", (e) => {
        const event = e.payload;
        if (event.mission_id && event.mission_id !== missionId) return;
        if (!event.message) return;
        setActivityByMission((current) => ({
          ...current,
          [missionId]: [...(current[missionId] ?? []), event.message],
        }));
        setRuntimeByMission((current) => ({
          ...current,
          [missionId]: { ...current[missionId], status: "running", step: (current[missionId]?.step ?? -1) + 1 },
        }));
      });

      unlistenPatch = await listen<PatchProposal>("patch_proposal", (e) => {
        const patch = e.payload;
        setPatchDiffByMission((current) => ({ ...current, [missionId]: patch.diff }));
        setRuntimeByMission((current) => ({
          ...current,
          [missionId]: { ...current[missionId], status: "review", patchStatus: "pending", step: (current[missionId]?.step ?? 0) + 1 },
        }));
      });
    }

    try {
      const next = await sendAgentMessageLoopState(repoPath, missionId, text);
      if (next) {
        applyRepoState(next, missionId);
      }
    } catch (error) {
      if (cancelledMissionsRef.current.has(missionId)) return;
      console.error("[orbital] chat failed", error);
      setMissionLoopError(errorMessage(error, "Failed to send message."));
    } finally {
      unlistenEvent?.();
      unlistenPatch?.();
      unlistenChat?.();
      setChatSendingByMission((current) => ({ ...current, [missionId]: false }));
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
              // Worker is chosen once at intake; stamp it so dispatch uses it.
              if (lastMissionId) {
                const newId = lastMissionId;
                setWorkerModeByMission((current) => ({ ...current, [newId]: intakeWorkerMode }));
              }
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
      worker: intakeWorkerMode,
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
    setWorkerModeByMission((current) => ({ ...current, [missionId]: intakeWorkerMode }));
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

  // Delete a mission entirely — including a running one, in which case the
  // backend kills the live agent first. Removes its runs, patches, diffs, and
  // worktree along with it.
  const deleteMission = async (missionId: string) => {
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const running = runtimeByMission[missionId]?.status === "running";
    const label = mission?.title ?? "this mission";
    const prompt = running
      ? `Delete "${label}"? Its agent is still running and will be shut down.`
      : `Delete "${label}"? This removes its runs and proposed changes.`;
    if (!window.confirm(prompt)) {
      return;
    }

    setMissionLoopError("");
    cancelledMissionsRef.current.add(missionId);

    try {
      const nextMissionLoopState = await deleteMissionLoopState(repoPathForMission(missionId), missionId);
      if (nextMissionLoopState) {
        applyRepoState(nextMissionLoopState);
        return;
      }

      // Browser/demo mode: no backend, so drop the mission from local state.
      const pruned = removeMissionFromState(combineRepoStates(repoStatesRef.current), missionId);
      repoStatesRef.current = splitByRepository(pruned);
      hydrateMissionLoop(combineRepoStates(repoStatesRef.current));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to delete mission."));
    } finally {
      cancelledMissionsRef.current.delete(missionId);
    }
  };

  // Save an edited node prompt — the instruction its agent will run. Backed by
  // the worker in the desktop build, with a local fallback so the demo still
  // reflects the edit.
  const saveMissionPrompt = async (missionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setMissionLoopError("");
    try {
      const nextMissionLoopState = await updateMissionTextLoopState(repoPathForMission(missionId), missionId, trimmed);
      if (nextMissionLoopState) {
        applyRepoState(nextMissionLoopState, missionId);
        setEditingPrompt(false);
        return;
      }

      // Browser/demo mode: no backend, so update the mission text locally.
      const combined = combineRepoStates(repoStatesRef.current);
      const updated = {
        ...combined,
        missions: combined.missions.map((mission) =>
          mission.id === missionId ? { ...mission, text: trimmed } : mission,
        ),
      };
      repoStatesRef.current = splitByRepository(updated);
      hydrateMissionLoop(updated, selectedNodeId);
      setEditingPrompt(false);
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to save prompt."));
    }
  };

  const beginEditPrompt = () => {
    setPromptDraft(selectedMissionRecord?.text ?? selectedMission?.title ?? "");
    setEditingPrompt(true);
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
    setChatByMission(groupChatByMission(nextMissionLoopState.chat_messages));
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
        onSelectNode={handleSelectNode}
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
          <label className="intake-worker">
            <span>Worker</span>
            <select
              aria-label="Worker mode"
              value={intakeWorkerMode}
              onChange={(event) => setIntakeWorkerMode(event.target.value as WorkerMode)}
            >
              <option value="claude-manager">Claude Manager (AI)</option>
              <option value="mock">Demo worker</option>
              <option value="local-command">Local command</option>
            </select>
          </label>
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
                    {missionIsLaunchable(mission.id) ? (
                      <select
                        className="control-worker"
                        aria-label="Worker"
                        value={workerModeByMission[mission.id] ?? workerModeFromName(mission.worker)}
                        onChange={(event) =>
                          setWorkerModeByMission((current) => ({ ...current, [mission.id]: event.target.value as WorkerMode }))
                        }
                      >
                        <option value="claude-manager">Claude</option>
                        <option value="mock">Demo</option>
                        <option value="local-command">Local</option>
                      </select>
                    ) : null}
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
                    <button
                      className="ghost mini danger"
                      type="button"
                      onClick={() => void deleteMission(mission.id)}
                      title={status === "running" ? "Delete — shuts the agent down" : "Delete mission"}
                      aria-label="Delete mission"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {missionLoopError ? <div className="floating-error">{missionLoopError}</div> : null}

      {selectedMission ? (
        <aside className="inspector" aria-label="Review">
          <section className="console-panel review-panel" aria-label="Mission review">
            <div className="panel-head review-head">
              <div>
                <div className="section-label">
                  {selectedRepository?.name ?? "workspace"} · review
                </div>
                <h2 className="work-order-title">{selectedMission.title}</h2>
              </div>
              <div className={`mini-state ${missionStatus.className}`}>{missionStatus.label}</div>
            </div>

            <div className="node-actions" aria-label="Node actions">
              <button
                className="node-action secondary"
                type="button"
                onClick={() => void dispatchMission(selectedMission.id)}
                disabled={selectedRuntime.status === "running"}
                title="Run this node's agent"
              >
                <Play size={14} aria-hidden="true" />
                <span>Run</span>
              </button>
              <button
                className={`node-action secondary ${editingPrompt ? "active" : ""}`}
                type="button"
                onClick={editingPrompt ? () => setEditingPrompt(false) : beginEditPrompt}
                disabled={selectedRuntime.status === "running"}
                title="Edit this node's prompt"
              >
                <Pencil size={14} aria-hidden="true" />
                <span>Edit</span>
              </button>
              <button
                className="node-action secondary danger"
                type="button"
                onClick={() => void deleteMission(selectedMission.id)}
                title="Remove this node"
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>Remove</span>
              </button>
            </div>

            {editingPrompt ? (
              <div className="node-prompt-editor">
                <textarea
                  className="node-prompt-input"
                  aria-label="Node prompt"
                  value={promptDraft}
                  onChange={(event) => setPromptDraft(event.target.value)}
                  rows={4}
                  autoFocus
                />
                <div className="node-prompt-actions">
                  <button className="node-action secondary" type="button" onClick={() => setEditingPrompt(false)}>
                    Cancel
                  </button>
                  <button
                    className="node-action primary"
                    type="button"
                    disabled={!promptDraft.trim()}
                    onClick={() => void saveMissionPrompt(selectedMission.id, promptDraft)}
                  >
                    Save prompt
                  </button>
                </div>
              </div>
            ) : null}

            <div className="review-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={reviewTab === "changes"}
                className={`review-tab ${reviewTab === "changes" ? "active" : ""}`}
                onClick={() => setReviewTab("changes")}
              >
                Changes
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={reviewTab === "activity"}
                className={`review-tab ${reviewTab === "activity" ? "active" : ""}`}
                onClick={() => setReviewTab("activity")}
              >
                Activity{activity.length > 0 ? <span className="tab-count">{activity.length}</span> : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={reviewTab === "chat"}
                className={`review-tab ${reviewTab === "chat" ? "active" : ""}`}
                onClick={() => setReviewTab("chat")}
              >
                Chat
              </button>
              {reviewTab === "changes" && patchReady ? (
                <button
                  className="secondary icon-button mini review-expand"
                  type="button"
                  onClick={() => setDiffModalOpen(true)}
                  title="Expand diff"
                  aria-label="Expand diff"
                >
                  <Maximize2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>

            {reviewTab === "changes" ? (
              <div className="review-changes">
                <DiffView
                  diff={patchReady ? selectedPatchDiff : ""}
                  focusPath={focusedDiffFile}
                  emptyLabel={
                    patchReady
                      ? "No patch proposal captured for this mission."
                      : "No changes yet — this mission hasn't reached review."
                  }
                />

                <div className="verify-bar">
                  <button
                    type="button"
                    className="verify-status-toggle"
                    onClick={() => setVerifyOpen((open) => !open)}
                    aria-expanded={verifyOpen}
                  >
                    <span className={`verify-pill ${verifyPillClass(selectedRuntime)}`}>
                      {verifyPillLabel(selectedRuntime)}
                    </span>
                    <ChevronDown size={14} className={`verify-chevron ${verifyOpen ? "open" : ""}`} aria-hidden="true" />
                  </button>
                  <button
                    className="secondary mini"
                    type="button"
                    disabled={selectedRuntime.patchStatus !== "approved" || selectedRuntime.verified || !selectedVerificationCommand.trim()}
                    onClick={runVerification}
                    title="Run verification"
                  >
                    <Terminal size={14} aria-hidden="true" />
                    <span>Verify</span>
                  </button>
                </div>
                {verifyOpen ? (
                  <div className="verify-detail">
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
                  </div>
                ) : null}

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
              </div>
            ) : reviewTab === "activity" ? (
              <div className="review-activity">
                <div className="activity-toolbar">
                  <span className="activity-worker">
                    <RadioTower size={13} aria-hidden="true" />
                    {workerLabel(selectedMission.worker)}
                  </span>
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
              </div>
            ) : (
              <div className="review-chat">
                <AgentChat
                  messages={selectedChatMessages}
                  statusModel={agentStatus}
                  transcript={agentTranscript}
                  sending={selectedChatSending}
                  onSend={(text) => void sendAgentChat(selectedMission.id, text)}
                />
              </div>
            )}
          </section>
        </aside>
      ) : null}

      {workspaceMissions.length === 0 ? (
        <div className="canvas-hint">
          <p>Open a workspace, then queue a mission to begin.</p>
        </div>
      ) : null}

      {diffModalOpen && selectedMission ? (
        <div className="diff-modal-backdrop" onClick={() => setDiffModalOpen(false)}>
          <div className="diff-modal" role="dialog" aria-label="Diff" onClick={(event) => event.stopPropagation()}>
            <div className="diff-modal-head">
              <div>
                <div className="section-label">{selectedRepository?.name ?? "workspace"} · review</div>
                <h2>{selectedMission.title}</h2>
              </div>
              <button className="secondary icon-button" type="button" onClick={() => setDiffModalOpen(false)} aria-label="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <DiffView
              diff={patchReady ? selectedPatchDiff : ""}
              focusPath={focusedDiffFile}
              emptyLabel="No changes yet — this mission hasn't reached review."
            />
            <div className="actions">
              <button
                className="secondary"
                type="button"
                disabled={!patchReady || selectedRuntime.patchStatus !== "pending"}
                onClick={() => {
                  void rejectPatch();
                  setDiffModalOpen(false);
                }}
              >
                <X size={16} aria-hidden="true" />
                <span>Reject</span>
              </button>
              <button
                className="primary"
                type="button"
                disabled={!patchReady || selectedRuntime.patchStatus !== "pending"}
                onClick={() => {
                  void approvePatch();
                  setDiffModalOpen(false);
                }}
              >
                <Check size={16} aria-hidden="true" />
                <span>Approve + apply</span>
              </button>
            </div>
          </div>
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

function defaultLocalCommand() {
  return `printf 'diff --git a/orbital-local-worker.txt b/orbital-local-worker.txt\nnew file mode 100644\n--- /dev/null\n+++ b/orbital-local-worker.txt\n@@ -0,0 +1 @@\n+local worker completed\n' > "$ORBITAL_PATCH_PATH"`;
}

// buildAgentTranscript turns persisted workflow events into the agent's
// thoughts + actions stream, scoped to one run when a specific agent is
// selected, otherwise the whole mission's agents in order.
function buildAgentTranscript(state: MissionLoopState, missionId: string, runId: string | undefined): TranscriptEntry[] {
  const runById = new Map(state.agent_runs.map((run) => [run.id, run]));
  const labelForRun = (rid: string | undefined) => {
    const run = rid ? runById.get(rid) : undefined;
    return run ? roleLabel(run.worker_name) : "";
  };
  // Cluster each agent's events together by ordering on when its run started,
  // then chronologically within the run — so the mission-wide view reads
  // manager → engineer → reviewer rather than interleaving them.
  const runStart = (rid: string | undefined) => (rid ? runById.get(rid)?.started_at ?? "" : "");

  return state.workflow_events
    .filter((event) => {
      if (runId) return event.run_id === runId;
      return event.mission_id === missionId;
    })
    .slice()
    .sort((a, b) => runStart(a.run_id).localeCompare(runStart(b.run_id)) || a.created_at.localeCompare(b.created_at))
    .map((event) => {
      const kind =
        event.type === "agent_thought"
          ? "thought"
          : event.type === "agent_action" || event.type === "command_executed" || event.type === "file_read"
            ? "action"
            : "status";
      return { id: event.id, kind, text: event.message, agent: labelForRun(event.run_id) } as TranscriptEntry;
    })
    .filter((entry) => entry.text.trim() !== "");
}

// groupChatByMission buckets the flat chat log into per-mission conversations,
// each ordered oldest-first so the thread reads top to bottom.
function groupChatByMission(messages: ChatMessage[]): Record<string, ChatMessage[]> {
  const byMission: Record<string, ChatMessage[]> = {};
  for (const message of messages) {
    (byMission[message.mission_id] ??= []).push(message);
  }
  for (const list of Object.values(byMission)) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return byMission;
}

function verifyPillLabel(runtime: WorkspaceRuntime) {
  if (runtime.verified) return "Verification passed";
  if (runtime.status === "blocked") return "Verification failed";
  if (runtime.patchStatus === "approved") return "Not verified yet";
  return "Awaiting verification";
}

function verifyPillClass(runtime: WorkspaceRuntime) {
  if (runtime.verified) return "passed";
  if (runtime.status === "blocked") return "failed";
  if (runtime.patchStatus === "approved") return "ready";
  return "pending";
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
