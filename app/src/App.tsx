import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  CircleDot,
  Gauge,
  History,
  Maximize2,
  Network,
  Pencil,
  Play,
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
import { HistoryPanel } from "./components/HistoryPanel";
import { buildAgentStatus, parseDiffFiles } from "./agentStatus";
import {
  type MissionNodeStatus,
  type WorkspaceGraphEdge,
  type WorkspaceGraphNode,
  type WorkspaceMission,
} from "./graph";
import type { ChatMessage, MissionLoopState, PatchProposal, RepoCommit, Repository, WorkflowEvent } from "./domain";
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
  linkMissionsLoopState,
  loadCommitDiff,
  loadMissionLoopState,
  loadRepoHistory,
  openMissionLoopRepository,
  queueMissionLoopState,
  rejectPatchMissionLoopState,
  refreshMissionLoopState,
  sendAgentMessageLoopState,
  startAgentRunMissionLoopState,
  unlinkMissionsLoopState,
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

// The single canvas draft-task card. It exists only in the rendered graph until
// Queue/Run turns it into a real mission, so one well-known id is enough.
const DRAFT_TASK_NODE_ID = "task_draft";

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
  // Which full-width view the task window shows, and whether the verification
  // detail (command + output) is expanded under the diff.
  const [taskView, setTaskView] = useState<"chat" | "changes">("chat");
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
  // Whether a draft task card is open on the canvas ("+ Task" was clicked).
  const [draftingTask, setDraftingTask] = useState(false);
  // Inline prompt editor for refining a mission's instruction before launch.
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [openPanel, setOpenPanel] = useState<null | "repo" | "mission" | "control" | "history">(null);
  // Git history of the active workspace: the commit list, and the commit whose
  // diff is open in the wide viewer.
  const [repoHistory, setRepoHistory] = useState<RepoCommit[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyCommit, setHistoryCommit] = useState<RepoCommit | null>(null);
  const [historyDiff, setHistoryDiff] = useState("");
  const togglePanel = (panel: "repo" | "mission" | "control" | "history") =>
    setOpenPanel((current) => {
      const next = current === panel ? null : panel;
      // Opening intake starts from the current repo; campaign targets are opt-in.
      if (next === "mission") setCampaignRepoIds([]);
      // History reads git fresh on every open, so landed patches show up.
      if (next === "history") void refreshRepoHistory();
      return next;
    });

  const refreshRepoHistory = async () => {
    setHistoryLoading(true);
    try {
      setRepoHistory(await loadRepoHistory(activeRepoPath));
    } catch (error) {
      console.error("[orbital] history failed", error);
      setRepoHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const openHistoryCommit = async (commit: RepoCommit) => {
    setHistoryCommit(commit);
    setHistoryDiff("");
    try {
      setHistoryDiff(await loadCommitDiff(activeRepoPath, commit.hash));
    } catch (error) {
      console.error("[orbital] commit diff failed", error);
      setHistoryDiff("");
    }
  };

  // Selecting a node opens the task window on that step's surface: task and
  // agent land in the chat, changes and verify land in the diff.
  const handleSelectNode = (nodeId: string) => {
    // The draft card is an input surface, not a mission — clicking it while
    // typing must not steal the selection onto some other node.
    if (nodeId === DRAFT_TASK_NODE_ID) return;
    setSelectedNodeId(nodeId);
    const node = workspaceGraphNodes.find((item) => item.id === nodeId);
    if (!node) return;
    switch (node.kind) {
      case "changes":
        setTaskView("changes");
        break;
      case "verify":
        setTaskView("changes");
        setVerifyOpen(true);
        break;
      case "task":
      case "agent":
      case "tool":
        setTaskView("chat");
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
    if (!selectedGraphNode || selectedGraphNode.kind !== "agent") return undefined;
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
  const missionStatus = missionStatusFor(selectedRuntime, patchReady);
  const selectedChatMessages = chatByMission[selectedMission?.id ?? ""] ?? [];
  const selectedChatSending = chatSendingByMission[selectedMission?.id ?? ""] ?? false;

  // Close the inline prompt editor whenever the selected node changes, so an
  // unsaved draft never leaks onto a different mission.
  useEffect(() => {
    setEditingPrompt(false);
    setTaskView("chat");
  }, [selectedMissionId]);

  const visibleMissions = useMemo(
    () =>
      workspaceMissions.map((mission) => ({
        ...mission,
        runtime: runtimeByMission[mission.id],
      })),
    [runtimeByMission, workspaceMissions],
  );
  // Enrich each pipeline card with the live data its step operates on: the
  // task's worker + launchability, the agent's "now" line, the change set's
  // stats and gate state, the verify command and result.
  const graphNodes = useMemo(() => {
    // An upstream has landed when its patch was approved or — for tool steps,
    // which have no patch gate — when its command finished as verified.
    const upstreamLanded = (id: string) => {
      const upstream = runtimeByMission[id];
      return upstream?.patchStatus === "approved" || upstream?.status === "approved" || upstream?.status === "verified";
    };

    return (
      workspaceGraphNodes.map((node) => {
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
            return {
              ...node,
              status,
              meta: {
                ...node.meta,
                worker: workerModeLabel(workerModeByMission[missionId] ?? workerModeFromName(mission?.worker)),
                launchable,
                waitingFor: firstUpstream ? missionLabel(firstUpstream.title) : undefined,
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
                waitingFor: firstUpstream ? missionLabel(firstUpstream.title) : undefined,
                verifyState: status === "verified" ? ("passed" as const) : status === "blocked" ? ("failed" as const) : undefined,
              },
            };
          }
          case "agent": {
            const live = runtime?.status === "running";
            return {
              ...node,
              status,
              meta: { ...node.meta, live, now: live ? activityByMission[missionId]?.at(-1) : undefined },
            };
          }
          case "changes": {
            const diff = patchDiffByMission[missionId] ?? "";
            const files = parseDiffFiles(diff);
            return {
              ...node,
              status,
              meta: {
                ...node.meta,
                files: files.length,
                additions: files.reduce((sum, file) => sum + file.added, 0),
                deletions: files.reduce((sum, file) => sum + file.removed, 0),
                patchState: diff ? runtime?.patchStatus ?? ("pending" as const) : ("none" as const),
              },
            };
          }
          case "verify": {
            const output = verificationOutputByMission[missionId] ?? "";
            const verifyState = runtime?.verified
              ? ("passed" as const)
              : output
                ? ("failed" as const)
                : runtime?.patchStatus === "approved"
                  ? ("ready" as const)
                  : ("idle" as const);
            return {
              ...node,
              status,
              meta: {
                ...node.meta,
                command: verificationCommandByMission[missionId] ?? node.meta?.command,
                verifyState,
              },
            };
          }
          default:
            return { ...node, status };
        }
      })
    );
  }, [
    runtimeByMission,
    workspaceGraphNodes,
    workspaceMissions,
    workerModeByMission,
    activityByMission,
    patchDiffByMission,
    verificationOutputByMission,
    verificationCommandByMission,
  ]);

  const graphEdges = workspaceGraphEdges;

  // The repository that will own a task drafted on the canvas: the selected
  // one, else the active workspace, else whatever is connected.
  const draftRepository =
    selectedRepository ??
    missionLoopState.repositories.find((repo) => repo.path === activeRepoPath) ??
    missionLoopState.repositories[0];

  // While "+ Task" is open, the canvas shows one extra draft card wired to its
  // repo, in its own lane — authored in place, committed via Queue/Run.
  const canvasNodes = useMemo(() => {
    if (!draftingTask) return graphNodes;
    return [
      ...graphNodes,
      {
        id: DRAFT_TASK_NODE_ID,
        kind: "task" as const,
        label: "New task",
        detail: "task",
        mission_id: DRAFT_TASK_NODE_ID,
        repository_id: draftRepository?.id,
        meta: { draft: true, worker: workerModeLabel(intakeWorkerMode) },
      },
    ];
  }, [graphNodes, draftingTask, draftRepository?.id, intakeWorkerMode]);

  const canvasEdges = useMemo(() => {
    if (!draftingTask || !draftRepository) return graphEdges;
    return [
      ...graphEdges,
      { id: "edge_task_draft", from: draftRepository.id, to: DRAFT_TASK_NODE_ID, kind: "owns" as const },
    ];
  }, [graphEdges, draftingTask, draftRepository]);

  // Turn the canvas draft into a real mission: queue it in the owning repo and
  // optionally launch it right away. The fresh state hasn't landed in React
  // state yet, so the repo path and worker are passed to dispatch explicitly.
  // A tool draft's text doubles as its shell command; the worker resolves its
  // execution itself, so no worker mode is stamped or passed for tools.
  const createTaskOnCanvas = async (text: string, run: boolean, kind: "task" | "tool") => {
    setDraftingTask(false);
    if (!draftRepository) return;
    setMissionLoopError("");
    const isTool = kind === "tool";

    if (!isTauriRuntime()) {
      const missionId = addLocalMission(text, 0, draftRepository.id, isTool ? text : undefined);
      if (run) void dispatchMission(missionId, { repoPath: draftRepository.path, workerMode: isTool ? undefined : intakeWorkerMode });
      return;
    }

    try {
      const nextMissionLoopState = await queueMissionLoopState(draftRepository.path, text, undefined, isTool ? text : undefined);
      const missionId = nextMissionLoopState?.missions.at(-1)?.id;
      if (nextMissionLoopState) applyRepoState(nextMissionLoopState, missionId);
      if (missionId) {
        if (!isTool) setWorkerModeByMission((current) => ({ ...current, [missionId]: intakeWorkerMode }));
        if (run) void dispatchMission(missionId, { repoPath: draftRepository.path, workerMode: isTool ? undefined : intakeWorkerMode });
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to create task."));
    }
  };

  // linkTasks records a drawn task→task chain: the downstream task will start
  // automatically once the upstream patch lands. Links live in the worker's
  // state; the browser demo keeps them locally so the chain still executes.
  const linkTasks = async (fromMissionId: string, toMissionId: string) => {
    setMissionLoopError("");
    const from = workspaceMissions.find((m) => m.id === fromMissionId);
    const to = workspaceMissions.find((m) => m.id === toMissionId);
    if (!from || !to) return;
    if (from.repository_id !== to.repository_id) {
      setMissionLoopError("Chained tasks must live in the same repository.");
      return;
    }

    if (isTauriRuntime()) {
      try {
        const next = await linkMissionsLoopState(repoPathForMission(toMissionId), fromMissionId, toMissionId);
        if (next) applyRepoState(next);
      } catch (error) {
        setMissionLoopError(errorMessage(error, "Failed to link tasks."));
      }
      return;
    }

    if (locallyDependsOn(fromMissionId, toMissionId)) {
      setMissionLoopError("That link would create a cycle.");
      return;
    }
    setWorkspaceMissions((current) =>
      current.map((mission) =>
        mission.id === toMissionId && !(mission.depends_on ?? []).includes(fromMissionId)
          ? { ...mission, depends_on: [...(mission.depends_on ?? []), fromMissionId] }
          : mission,
      ),
    );
    setWorkspaceGraphEdges((current) => {
      // A chained task hangs off its upstream, not the repo (mirrors the
      // adapter's rule for worker-derived graphs).
      const withoutOwns = current.filter((edge) => !(edge.kind === "owns" && edge.to === toMissionId));
      return withoutOwns.some((edge) => edge.id === `then_${fromMissionId}_${toMissionId}`)
        ? withoutOwns
        : [...withoutOwns, { id: `then_${fromMissionId}_${toMissionId}`, from: fromMissionId, to: toMissionId, kind: "then" }];
    });
  };

  const unlinkTasks = async (fromMissionId: string, toMissionId: string) => {
    setMissionLoopError("");

    if (isTauriRuntime()) {
      try {
        const next = await unlinkMissionsLoopState(repoPathForMission(toMissionId), fromMissionId, toMissionId);
        if (next) applyRepoState(next);
      } catch (error) {
        setMissionLoopError(errorMessage(error, "Failed to unlink tasks."));
      }
      return;
    }

    setWorkspaceMissions((current) =>
      current.map((mission) =>
        mission.id === toMissionId
          ? { ...mission, depends_on: (mission.depends_on ?? []).filter((id) => id !== fromMissionId) }
          : mission,
      ),
    );
    setWorkspaceGraphEdges((current) => {
      const next = current.filter((edge) => edge.id !== `then_${fromMissionId}_${toMissionId}`);
      // Unlinking the last upstream turns the task back into a chain head, so
      // it reattaches to its repo.
      const to = workspaceMissions.find((mission) => mission.id === toMissionId);
      const remaining = (to?.depends_on ?? []).filter((id) => id !== fromMissionId);
      if (to && remaining.length === 0 && !next.some((edge) => edge.kind === "owns" && edge.to === toMissionId)) {
        next.push({ id: `edge_${to.repository_id}_${toMissionId}`, from: to.repository_id, to: toMissionId, kind: "owns" });
      }
      return next;
    });
  };

  // Does `missionId` already depend on `targetId`, directly or through a chain?
  // Mirrors the worker's cycle guard for the browser demo.
  const locallyDependsOn = (missionId: string, targetId: string): boolean => {
    const depsById = new Map(workspaceMissions.map((mission) => [mission.id, mission.depends_on ?? []]));
    const seen = new Set<string>();
    const stack = [missionId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === targetId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(depsById.get(current) ?? []));
    }
    return false;
  };

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
  // selection, so several can be fired concurrently. Overrides cover missions
  // created a moment ago whose state isn't in this closure yet.
  const dispatchMission = async (missionId: string, overrides?: { repoPath?: string; workerMode?: WorkerMode }) => {
    setMissionLoopError("");
    const repoPath = overrides?.repoPath ?? repoPathForMission(missionId);
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const workerMode = overrides?.workerMode ?? workerModeByMission[missionId] ?? workerModeFromName(mission?.worker);
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
        // A tool mission lands the moment its command exits cleanly — there is
        // no approve gate to fire the chain from, so release downstream tasks
        // here. AI missions end a run in waiting_approval, making this a no-op;
        // their cascade stays with approveMission.
        const finished = nextMissionLoopState.missions.find((mission) => mission.id === missionId);
        if (finished && ["approved", "applied", "verified"].includes(finished.status)) {
          autoDispatchChained(missionId, nextMissionLoopState);
        }
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
  const addLocalMission = (title: string, offset: number, repositoryId: string, toolCommand?: string): string => {
    const missionId = `mission_${Date.now()}_${offset}`;
    const targetRepositoryId = repositoryId;
    const isTool = Boolean(toolCommand);
    const mission: WorkspaceMission = {
      id: missionId,
      repository_id: targetRepositoryId,
      title,
      status: "queued",
      worker: intakeWorkerMode,
      command: toolCommand ?? "npm run build",
      files: [],
      step: -1,
      patch_status: "pending",
      verified: false,
      map_position: "center",
      kind: isTool ? "tool" : undefined,
    };
    const missionNode: WorkspaceGraphNode = isTool
      ? {
          id: missionId,
          kind: "tool",
          label: missionLabel(title),
          detail: toolCommand ?? "",
          meta: { prompt: title, command: toolCommand },
          mission_id: missionId,
          repository_id: targetRepositoryId,
        }
      : {
          id: missionId,
          kind: "task",
          label: missionLabel(title),
          detail: "task",
          meta: { prompt: title },
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
        autoDispatchChained(missionId, nextMissionLoopState);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to approve patch."));
      return;
    }

    setMissionRuntime(missionId, (current) => ({ ...current, patchStatus: "approved", status: "approved" }));

    // Browser demo: release chained tasks using the local runtime, treating the
    // mission just approved as landed (its state update is still in flight).
    const landedLocally = (id: string) => id === missionId || runtimeByMission[id]?.patchStatus === "approved";
    workspaceMissions.forEach((mission) => {
      const deps = mission.depends_on ?? [];
      if (!deps.includes(missionId)) return;
      const status = runtimeByMission[mission.id]?.status ?? "queued";
      if (status !== "queued" && status !== "draft") return;
      if (!deps.every(landedLocally)) return;
      void dispatchMission(mission.id);
    });
  };

  // A landed patch releases the tasks chained behind it: every mission that
  // depends on the landed one — and whose other upstreams have all landed too —
  // dispatches automatically. This is what makes a drawn chain execute.
  const autoDispatchChained = (landedMissionId: string, state: MissionLoopState) => {
    const landed = new Set(
      state.missions
        .filter((mission) => mission.status === "approved" || mission.status === "applied" || mission.status === "verified")
        .map((mission) => mission.id),
    );
    landed.add(landedMissionId);

    state.missions.forEach((mission) => {
      const deps = mission.depends_on ?? [];
      if (!deps.includes(landedMissionId)) return;
      // Only tasks that never ran wait in "draft"; anything else already
      // started (or finished) and must not be re-fired.
      if (mission.status !== "draft") return;
      if (!deps.every((id) => landed.has(id))) return;
      const repoPath = state.repositories.find((repo) => repo.id === mission.repository_id)?.path;
      void dispatchMission(mission.id, { repoPath });
    });
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

  const runVerificationFor = async (missionId: string) => {
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const command = (verificationCommandByMission[missionId] ?? mission?.command ?? "").trim();
    if (!command) {
      setMissionLoopError("Verification command is required.");
      return;
    }

    setMissionLoopError("");

    try {
      const nextMissionLoopState = await verifyMissionLoopState(repoPathForMission(missionId), missionId, command);
      if (nextMissionLoopState) {
        applyRepoState(nextMissionLoopState, missionId);
        return;
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to run verification."));
      return;
    }

    setMissionRuntime(missionId, (current) => ({ ...current, verified: true, status: "verified" }));
  };

  const runVerification = () => runVerificationFor(selectedMission.id);

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
        nodes={canvasNodes}
        edges={canvasEdges}
        selectedNodeId={selectedGraphNode?.id ?? ""}
        selectedMissionId={selectedMission?.id ?? ""}
        runningMissionIds={runningMissionIds}
        onSelectNode={handleSelectNode}
        onAddTask={() => setDraftingTask(true)}
        canAddTask={Boolean(draftRepository)}
        actions={{
          onRunTask: (missionId) => void dispatchMission(missionId),
          onApprove: (missionId) => void approveMission(missionId),
          onReject: (missionId) => void rejectMission(missionId),
          onVerify: (missionId) => void runVerificationFor(missionId),
          onCreateTask: (text, run, kind) => void createTaskOnCanvas(text, run, kind),
          onCancelDraft: () => setDraftingTask(false),
          onLinkTasks: (from, to) => void linkTasks(from, to),
          onUnlinkTasks: (from, to) => void unlinkTasks(from, to),
        }}
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
            className={`chip ${openPanel === "history" ? "active" : ""}`}
            type="button"
            onClick={() => togglePanel("history")}
            title="Git history"
          >
            <History size={15} aria-hidden="true" />
            <span>History</span>
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

      {openPanel === "history" ? (
        <section className="popover history-popover" aria-label="Git history">
          <div className="section-label">
            {selectedRepository?.name ?? "workspace"} · history
          </div>
          <HistoryPanel commits={repoHistory} loading={historyLoading} onSelect={(commit) => void openHistoryCommit(commit)} />
        </section>
      ) : null}

      {missionLoopError ? <div className="floating-error">{missionLoopError}</div> : null}

      {selectedMission ? (
        <aside className="inspector task-window" aria-label="Task">
          <section className="task-panel" aria-label="Task">
            <div className="panel-head review-head">
              <div>
                <div className="section-label">
                  {selectedRepository?.name ?? "workspace"} · task
                </div>
                <h2 className="work-order-title">{selectedMission.title}</h2>
              </div>
              <div className="task-head-actions">
                <div className={`mini-state ${missionStatus.className}`}>{missionStatus.label}</div>
                <button
                  className={`node-action secondary ${editingPrompt ? "active" : ""}`}
                  type="button"
                  onClick={editingPrompt ? () => setEditingPrompt(false) : beginEditPrompt}
                  disabled={selectedRuntime.status === "running"}
                  title="Edit this task's prompt"
                >
                  <Pencil size={14} aria-hidden="true" />
                  <span>Edit</span>
                </button>
                <button
                  className="node-action secondary danger"
                  type="button"
                  onClick={() => void deleteMission(selectedMission.id)}
                  title="Remove this task"
                >
                  <Trash2 size={14} aria-hidden="true" />
                  <span>Remove</span>
                </button>
              </div>
            </div>

            {editingPrompt ? (
              <div className="node-prompt-editor">
                <textarea
                  className="node-prompt-input"
                  aria-label="Task prompt"
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

            <div className="task-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={taskView === "chat"}
                className={`task-switch-btn ${taskView === "chat" ? "active" : ""}`}
                onClick={() => setTaskView("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={taskView === "changes"}
                className={`task-switch-btn ${taskView === "changes" ? "active" : ""}`}
                onClick={() => setTaskView("changes")}
              >
                Changes
                {agentStatus.files.length > 0 ? (
                  <span className="tab-count">{agentStatus.files.length}</span>
                ) : null}
                {patchReady && taskView !== "changes" ? <span className="task-switch-dot" aria-hidden="true" /> : null}
              </button>
              <div className="task-switch-spacer" />
              {taskView === "changes" && patchReady ? (
                <button
                  className="secondary icon-button mini"
                  type="button"
                  onClick={() => setDiffModalOpen(true)}
                  title="Expand diff"
                  aria-label="Expand diff"
                >
                  <Maximize2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className="task-body">
              {taskView === "chat" ? (
                <AgentChat
                  messages={selectedChatMessages}
                  statusModel={agentStatus}
                  transcript={agentTranscript}
                  files={agentStatus.files}
                  onOpenFile={(path) => {
                    setFocusedDiffFile(path);
                    setTaskView("changes");
                  }}
                  sending={selectedChatSending}
                  onSend={(text) => void sendAgentChat(selectedMission.id, text)}
                  readOnly={selectedMission.kind === "tool"}
                />
              ) : (
                <div className="task-changes">
                  <DiffView
                    diff={patchReady ? selectedPatchDiff : ""}
                    focusPath={focusedDiffFile}
                    emptyLabel={
                      patchReady
                        ? "No patch proposal captured for this task."
                        : "No changes yet — chat with the agent to make some."
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
              )}
            </div>
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

      {historyCommit ? (
        <div className="diff-modal-backdrop" onClick={() => setHistoryCommit(null)}>
          <div className="diff-modal" role="dialog" aria-label="Commit" onClick={(event) => event.stopPropagation()}>
            <div className="diff-modal-head">
              <div>
                <div className="section-label">
                  {selectedRepository?.name ?? "workspace"} · commit <code>{historyCommit.short_hash}</code>
                </div>
                <h2>{historyCommit.subject}</h2>
              </div>
              <button className="secondary icon-button" type="button" onClick={() => setHistoryCommit(null)} aria-label="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <DiffView diff={historyDiff} emptyLabel="Loading commit…" />
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
