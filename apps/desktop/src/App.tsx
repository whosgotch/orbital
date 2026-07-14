import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  CircleDot,
  Cpu,
  History,
  Pencil,
  Plus,
  Rocket,
  Terminal,
  Trash2,
  FolderOpen,
  X,
} from "lucide-react";
import { GraphMap } from "./components/GraphMap";
import { DiffView } from "./components/DiffView";
import { AgentChat, ChangesCard } from "./components/AgentChat";
import { PlanPanel, PlanIntake, DocumentView } from "./components/PlanPanel";
import { ReviseBox } from "./components/ReviseBox";
import { PromptBar } from "./components/PromptBar";
import { HistoryPanel } from "./components/HistoryPanel";
import { attachmentLines } from "./attachments";
import { buildAgentStatus, parseDiffFiles } from "./agentStatus";
import { buildAgentTranscript, groupChatByMission } from "./agentTranscript";
import {
  defaultLocalCommand,
  errorMessage,
  missionStatusFor,
  queuedRuntime,
  repositoryFor,
  statusFromRuntime,
  verificationOutput,
  verifyPillClass,
  verifyPillLabel,
  workerModeFromName,
  workerModeLabel,
  type WorkerMode,
} from "./missionUi";
import {
  combineRepoStates,
  emptyMissionLoopState,
  mergeChatMessage,
  mergeWorkflowEvent,
  splitByRepository,
  upsertAgentRun,
  upsertPatchProposal,
} from "./repoStates";
import type { AgentRun, ChatMessage, MissionLoopState, PatchProposal, PlanFeedItem, PlanFormat, Repository, WorkflowEvent } from "./domain";
import { CURATED_MODELS, modelName } from "./models";
import {
  compactLabel,
  workspaceViewFromMissionLoop,
  type WorkspaceRuntimeMap,
} from "./workspaceAdapter";
import {
  approvePatchMissionLoopState,
  deleteMissionLoopState,
  demoRepoPath,
  linkMissionsLoopState,
  loadMissionLoopState,
  openMissionLoopRepository,
  planRepoLoopState,
  queueMissionLoopState,
  rejectPatchMissionLoopState,
  refreshMissionLoopState,
  sendAgentMessageLoopState,
  startAgentRunMissionLoopState,
  unlinkMissionsLoopState,
  updateMissionTextLoopState,
  verifyMissionLoopState,
} from "./missionLoopLoader";
import { useRepoHistory } from "./useRepoHistory";
import {
  forgetRecentRepo,
  lastOpenRepoPaths,
  persistOpenRepos,
  recentRepoPaths,
  rememberRecentRepo,
  repoNameFromPath,
} from "./recentRepos";

const initialWorkspaceView = workspaceViewFromMissionLoop(emptyMissionLoopState);

// The single canvas draft-task card. It exists only in the rendered graph until
// Queue/Run turns it into a real mission, so one well-known id is enough.
const DRAFT_TASK_NODE_ID = "task_draft";

// Unique-enough id for optimistic records and campaign grouping.
const freshId = (prefix: string) => `${prefix}_${Date.now()}`;

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
  const [activeRepoPath, setActiveRepoPath] = useState(demoRepoPath);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [planningRepoId, setPlanningRepoId] = useState("");
  // The AI's streamed steps while a plan is in flight — shown live on the
  // surface that started the plan (draft card or repo panel), then discarded.
  const [planFeed, setPlanFeed] = useState<PlanFeedItem[]>([]);
  const [missionDraft, setMissionDraft] = useState("");
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
  // Which full-width view the task window shows, and whether the verification
  // detail (command + output) is expanded under the diff. Research missions
  // show "doc" (the findings document) instead of "changes".
  const [taskView, setTaskView] = useState<"chat" | "changes" | "doc">("chat");
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
  const [intakeWorkerMode, setIntakeWorkerMode] = useState<WorkerMode>("claude-engineer");
  // Claude model for every AI run and chat turn, persisted across sessions.
  // Empty string means the claude CLI's own default.
  const [claudeModel, setClaudeModel] = useState(() => localStorage.getItem("orbital:model") ?? "");
  const pickClaudeModel = (model: string) => {
    setClaudeModel(model);
    localStorage.setItem("orbital:model", model);
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Per-mission model overrides, chosen on the intake card. Missions without
  // an entry follow the global pick.
  const [modelByMission, setModelByMission] = useState<Record<string, string>>({});
  // Whether a draft task card is open on the canvas ("+ Task" was clicked).
  const [draftingTask, setDraftingTask] = useState(false);
  // Inline prompt editor for refining a mission's instruction before launch.
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [openPanel, setOpenPanel] = useState<null | "mission" | "history">(null);
  const repoHistory = useRepoHistory(activeRepoPath);
  const togglePanel = (panel: "mission" | "history") =>
    setOpenPanel((current) => {
      const next = current === panel ? null : panel;
      // Opening intake starts from the current repo; campaign targets are opt-in.
      if (next === "mission") setCampaignRepoIds([]);
      // History reads git fresh on every open, so landed patches show up.
      if (next === "history") void repoHistory.refresh();
      return next;
    });

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
      case "research":
        setTaskView("doc");
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

  // Selection is explicit: no selected node means no task panel. The panel is
  // mission-scoped, so repo and campaign nodes never open it.
  const selectedGraphNode = workspaceGraphNodes.find((node) => node.id === selectedNodeId);
  const selectedMissionId = selectedGraphNode?.mission_id;
  const selectedMission = workspaceMissions.find((mission) => mission.id === selectedMissionId);
  // The raw mission record carries the full prompt text — the WorkspaceMission's
  // title is only the short node label.
  const selectedMissionRecord = missionLoopState.missions.find((mission) => mission.id === selectedMission?.id);
  const selectedRepository = selectedMission ? repositoryFor(selectedMission, missionLoopState.repositories) : undefined;
  // A selected plan node shows its written document; a selected repo node offers
  // the planning intake. Both are node-scoped surfaces, like the task panel.
  const selectedPlan =
    selectedGraphNode?.kind === "plan"
      ? (missionLoopState.plans ?? []).find((plan) => plan.id === selectedGraphNode.id)
      : undefined;
  const selectedPlanTaskCount = selectedPlan
    ? missionLoopState.missions.filter((mission) => mission.plan_id === selectedPlan.id).length
    : 0;
  const selectedRepoForPlan =
    selectedGraphNode?.kind === "repo"
      ? missionLoopState.repositories.find((repo) => repo.id === selectedGraphNode.id)
      : undefined;
  const selectedRuntime = (selectedMission ? runtimeByMission[selectedMission.id] : undefined) ?? queuedRuntime;
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
    () => buildAgentTranscript(missionLoopState, selectedMissionId ?? "", selectedAgentRunId),
    [missionLoopState, selectedMissionId, selectedAgentRunId],
  );
  const selectedActivityKey = selectedMission?.id ?? "";
  const selectedActivity = useMemo(
    () => activityByMission[selectedActivityKey] ?? [],
    [activityByMission, selectedActivityKey],
  );
  const agentStatus = useMemo(
    () => buildAgentStatus(missionLoopState, selectedMissionId ?? "", selectedPatchDiff, selectedActivity, selectedRuntime),
    [missionLoopState, selectedMissionId, selectedPatchDiff, selectedActivity, selectedRuntime],
  );
  const missionStatus = missionStatusFor(selectedRuntime, patchReady);
  const selectedChatMessages = chatByMission[selectedMission?.id ?? ""] ?? [];
  const selectedChatSending = chatSendingByMission[selectedMission?.id ?? ""] ?? false;

  // Close the inline prompt editor whenever the selected node changes, so an
  // unsaved draft never leaks onto a different mission. Render-phase reset
  // (the React "adjust state on prop change" pattern) instead of an effect.
  const [editorMissionId, setEditorMissionId] = useState(selectedMissionId);
  if (editorMissionId !== selectedMissionId) {
    setEditorMissionId(selectedMissionId);
    setEditingPrompt(false);
    setTaskView(selectedMission?.kind === "research" ? "doc" : "chat");
  }

  // The research node's document, stored on the mission and rewritten in full
  // by the researcher every turn. Missions from before the document field
  // existed fall back to the latest assistant reply.
  const researchDoc =
    selectedMission?.kind === "research"
      ? selectedMissionRecord?.document ??
        [...selectedChatMessages].reverse().find((message) => message.role === "assistant")?.text ??
        ""
      : "";

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
                waitingFor: firstUpstream ? compactLabel(firstUpstream.title) : undefined,
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
                waitingFor: firstUpstream ? compactLabel(firstUpstream.title) : undefined,
                verifyState: status === "verified" ? ("passed" as const) : status === "blocked" ? ("failed" as const) : undefined,
              },
            };
          }
          case "research": {
            const mission = workspaceMissions.find((m) => m.id === missionId);
            const pendingUpstreams = (mission?.depends_on ?? []).filter((id) => !upstreamLanded(id));
            const firstUpstream = workspaceMissions.find((m) => m.id === pendingUpstreams[0]);
            const launchable =
              (!runtime || runtime.status === "queued" || runtime.status === "draft") && pendingUpstreams.length === 0;
            return {
              ...node,
              status,
              meta: {
                ...node.meta,
                launchable,
                waitingFor: firstUpstream ? compactLabel(firstUpstream.title) : undefined,
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
        meta: { draft: true },
      },
    ];
  }, [graphNodes, draftingTask, draftRepository?.id]);

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
  const createTaskOnCanvas = async (text: string, run: boolean, kind: "task" | "tool", worker: WorkerMode, model?: string) => {
    setDraftingTask(false);
    if (!draftRepository) return;
    setMissionLoopError("");
    const isTool = kind === "tool";

    try {
      const nextMissionLoopState = await queueMissionLoopState(draftRepository.path, text, undefined, isTool ? text : undefined);
      const missionId = nextMissionLoopState.missions.at(-1)?.id;
      applyRepoState(nextMissionLoopState);
      if (missionId) {
        if (!isTool) setWorkerModeByMission((current) => ({ ...current, [missionId]: worker }));
        if (model) setModelByMission((current) => ({ ...current, [missionId]: model }));
        if (run) void dispatchMission(missionId, { repoPath: draftRepository.path, workerMode: isTool ? undefined : worker, model });
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to create task."));
    }
  };

  // linkTasks records a drawn task→task chain: the downstream task will start
  // automatically once the upstream patch lands. Links live in the worker's
  // state.
  const linkTasks = async (fromMissionId: string, toMissionId: string) => {
    setMissionLoopError("");
    const from = workspaceMissions.find((m) => m.id === fromMissionId);
    const to = workspaceMissions.find((m) => m.id === toMissionId);
    if (!from || !to) return;
    if (from.repository_id !== to.repository_id) {
      setMissionLoopError("Chained tasks must live in the same repository.");
      return;
    }

    try {
      applyRepoState(await linkMissionsLoopState(repoPathForMission(toMissionId), fromMissionId, toMissionId));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to link tasks."));
    }
  };

  const unlinkTasks = async (fromMissionId: string, toMissionId: string) => {
    setMissionLoopError("");

    try {
      applyRepoState(await unlinkMissionsLoopState(repoPathForMission(toMissionId), fromMissionId, toMissionId));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to unlink tasks."));
    }
  };

  // Plan work on a repo: the AI reads the code and drops a plan node plus the
  // draft task nodes it fans out to. Nothing runs — the tasks are yours to steer.
  const planRepo = async (repo: Repository, goal: string, format: PlanFormat, model?: string) => {
    if (planningRepoId) return;
    setMissionLoopError("");
    setPlanningRepoId(repo.id);
    setPlanFeed([]);
    const runModel = model || claudeModel;
    const requestId = crypto.randomUUID();
    // The planner's steps stream on this request's own channel so parallel
    // surfaces (and future concurrent plans) never see each other's thinking.
    const unlisten = await listen<WorkflowEvent>(`plan_event:${requestId}`, (event) => {
      const step = event.payload;
      setPlanFeed((current) => [
        ...current,
        { kind: step.type === "agent_thought" ? "thought" : "action", text: step.message },
      ]);
    });
    try {
      const nextState = await planRepoLoopState(repo.path, goal, format, runModel, requestId);
      applyRepoState(nextState);
      setDraftingTask(false);
      // Tasks born from this plan inherit its model override, so a plan drawn
      // up by Opus runs its tasks on Opus too.
      if (model) {
        const plan = nextState.plans?.at(-1);
        if (plan) {
          const spawned = nextState.missions.filter((mission) => mission.plan_id === plan.id);
          setModelByMission((current) => ({
            ...current,
            ...Object.fromEntries(spawned.map((mission) => [mission.id, model])),
          }));
        }
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to plan the repo."));
    } finally {
      unlisten();
      setPlanningRepoId("");
      setPlanFeed([]);
    }
  };

  // Plan a goal typed into the draft card: the big-task path. The card stays
  // open showing the AI's thinking, then the plan node + its tasks replace it.
  const planGoalOnCanvas = (text: string, model?: string) => {
    if (!draftRepository) return;
    void planRepo(draftRepository, text, "md", model);
  };

  // Research typed into the prompt bar: the whole text is one question. It
  // dispatches immediately — a read-only run is always safe to start.
  const researchFromPrompt = async (text: string, attachments: string[]) => {
    if (!draftRepository) return;
    setMissionLoopError("");
    try {
      const nextMissionLoopState = await queueMissionLoopState(
        draftRepository.path,
        text + attachmentLines(attachments),
        undefined,
        undefined,
        true,
      );
      const missionId = nextMissionLoopState.missions.at(-1)?.id;
      applyRepoState(nextMissionLoopState);
      if (missionId) void dispatchMission(missionId, { repoPath: draftRepository.path });
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to start research."));
    }
  };

  // Create task(s) typed into the prompt bar: one mission per non-empty line,
  // landing in the repo that owns canvas drafts. Pasted screenshots ride along
  // with every task of the batch.
  const createFromPrompt = async (text: string, attachments: string[]) => {
    if (!draftRepository) return;
    setMissionLoopError("");
    const titles = text.split("\n").map((line) => line.trim()).filter(Boolean);
    try {
      for (const title of titles) {
        const nextMissionLoopState = await queueMissionLoopState(draftRepository.path, title + attachmentLines(attachments));
        const missionId = nextMissionLoopState.missions.at(-1)?.id;
        applyRepoState(nextMissionLoopState);
        if (missionId) {
          setWorkerModeByMission((current) => ({ ...current, [missionId]: intakeWorkerMode }));
        }
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to create task."));
    }
  };

  const runningMissionIds = useMemo(
    () => new Set(workspaceMissions.filter((m) => runtimeByMission[m.id]?.status === "running").map((m) => m.id)),
    [workspaceMissions, runtimeByMission],
  );

  const missionIsLaunchable = (missionId: string) => {
    const status = runtimeByMission[missionId]?.status;
    if (status === undefined || status === "queued" || status === "draft") return true;
    // A failed tool's Run is its re-run affordance (mirrors the canvas card).
    const mission = workspaceMissions.find((item) => item.id === missionId);
    return status === "blocked" && mission?.kind === "tool";
  };
  const launchableCount = workspaceMissions.filter((m) => missionIsLaunchable(m.id)).length;

  const repoPathForMission = (missionId: string) => {
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const repository = mission ? missionLoopState.repositories.find((repo) => repo.id === mission.repository_id) : undefined;
    return repository?.path ?? activeRepoPath;
  };

  // Launch every launchable mission at once. Each runs in its own worker
  // process and git worktree, so the backlog burns down in parallel.
  const launchAllMissions = () => {
    workspaceMissions
      .filter((mission) => missionIsLaunchable(mission.id))
      .forEach((mission) => void dispatchMission(mission.id));
  };

  // dispatchMission starts one mission by id, independent of the current
  // selection, so several can be fired concurrently. Overrides cover missions
  // created a moment ago whose state isn't in this closure yet.
  const dispatchMission = async (missionId: string, overrides?: { repoPath?: string; workerMode?: WorkerMode; model?: string }) => {
    setMissionLoopError("");
    const repoPath = overrides?.repoPath ?? repoPathForMission(missionId);
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const workerMode = overrides?.workerMode ?? workerModeByMission[missionId] ?? workerModeFromName(mission?.worker);
    const runModel = overrides?.model ?? modelByMission[missionId] ?? claudeModel;
    const localCommand = defaultLocalCommand();

    // Optimistically mark it running so the canvas pulses immediately.
    setRuntimeByMission((current) => ({
      ...current,
      [missionId]: { ...(current[missionId] ?? queuedRuntime), status: "running", step: Math.max(current[missionId]?.step ?? -1, 0) },
    }));

    // Merge each streamed record straight into the workspace state, so the
    // agent appears on the canvas the moment it starts, the transcript fills
    // while it thinks, and the changes gate opens the moment the patch
    // lands — not after the whole run finishes.
    const unlistenRun = await listen<AgentRun>("agent_run", (e) => {
      if (e.payload.mission_id !== missionId) return;
      mergeLiveRecord((state) => upsertAgentRun(state, e.payload));
    });

    const unlistenEvent = await listen<WorkflowEvent>("workflow_event", (e) => {
      // Parallel runs share one event channel; keep each mission's stream its own.
      if (e.payload.mission_id && e.payload.mission_id !== missionId) return;
      mergeLiveRecord((state) => mergeWorkflowEvent(state, e.payload));
    });

    const unlistenPatch = await listen<PatchProposal>("patch_proposal", (e) => {
      mergeLiveRecord((state) => upsertPatchProposal(state, e.payload));
    });

    try {
      const nextMissionLoopState = await startAgentRunMissionLoopState(
        repoPath,
        missionId,
        workerMode,
        workerMode === "local-command" ? localCommand : undefined,
        runModel,
      );
      applyRepoState(nextMissionLoopState);
      // A tool mission lands the moment its command exits cleanly — there is
      // no approve gate to fire the chain from, so release downstream tasks
      // here. AI missions end a run in waiting_approval, making this a no-op;
      // their cascade stays with approveMission.
      const finished = nextMissionLoopState.missions.find((mission) => mission.id === missionId);
      if (finished && ["approved", "applied", "verified"].includes(finished.status)) {
        autoDispatchChained(missionId, nextMissionLoopState);
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
      unlistenRun?.();
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
      id: freshId("local"),
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
      [missionId]: { ...(current[missionId] ?? queuedRuntime), status: "running", step: Math.max(current[missionId]?.step ?? -1, 0) },
    }));

    // Same live merging as dispatchMission: every streamed record lands in the
    // workspace state as it happens. The worker persists and streams the user's
    // turn first, so the optimistic bubble is replaced by the real record almost
    // immediately.
    const unlistenChat = await listen<ChatMessage>("chat_message", (e) => {
      if (e.payload.mission_id !== missionId) return;
      mergeLiveRecord((state) => mergeChatMessage(state, e.payload));
    });

    const unlistenRun = await listen<AgentRun>("agent_run", (e) => {
      if (e.payload.mission_id !== missionId) return;
      mergeLiveRecord((state) => upsertAgentRun(state, e.payload));
    });

    const unlistenEvent = await listen<WorkflowEvent>("workflow_event", (e) => {
      if (e.payload.mission_id && e.payload.mission_id !== missionId) return;
      mergeLiveRecord((state) => mergeWorkflowEvent(state, e.payload));
    });

    const unlistenPatch = await listen<PatchProposal>("patch_proposal", (e) => {
      mergeLiveRecord((state) => upsertPatchProposal(state, e.payload));
    });

    try {
      applyRepoState(await sendAgentMessageLoopState(repoPath, missionId, text, modelByMission[missionId] ?? claudeModel));
    } catch (error) {
      if (cancelledMissionsRef.current.has(missionId)) return;
      console.error("[orbital] chat failed", error);
      setMissionLoopError(errorMessage(error, "Failed to send message."));
    } finally {
      unlistenRun?.();
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

    try {
      for (let titleIndex = 0; titleIndex < titles.length; titleIndex++) {
        const title = titles[titleIndex];
        const campaignId = isCampaign ? `${freshId("camp")}_${titleIndex}` : undefined;
        for (const repo of targetRepos) {
          const nextMissionLoopState = await queueMissionLoopState(repo.path, title, campaignId);
          const missionId = nextMissionLoopState.missions.at(-1)?.id;
          applyRepoState(nextMissionLoopState);
          // Worker is chosen once at intake; stamp it so dispatch uses it.
          if (missionId) {
            setWorkerModeByMission((current) => ({ ...current, [missionId]: intakeWorkerMode }));
          }
        }
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to queue mission."));
    }
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

  const approveMission = async (missionId: string) => {
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await approvePatchMissionLoopState(repoPathForMission(missionId), missionId);
      applyRepoState(nextMissionLoopState);
      autoDispatchChained(missionId, nextMissionLoopState);
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to approve patch."));
    }
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
      applyRepoState(await rejectPatchMissionLoopState(repoPathForMission(missionId), missionId));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to reject patch."));
    }
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
      applyRepoState(await deleteMissionLoopState(repoPathForMission(missionId), missionId));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to delete mission."));
    } finally {
      cancelledMissionsRef.current.delete(missionId);
    }
  };

  // Save an edited node prompt — the instruction its agent will run.
  const saveMissionPrompt = async (missionId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    setMissionLoopError("");
    try {
      applyRepoState(await updateMissionTextLoopState(repoPathForMission(missionId), missionId, trimmed));
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
      applyRepoState(await verifyMissionLoopState(repoPathForMission(missionId), missionId, command));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to run verification."));
    }
  };

  const hydrateMissionLoop = (nextMissionLoopState: MissionLoopState) => {
    // Every state change records which repos are open, so the next session
    // starts from the same workspace.
    persistOpenRepos(nextMissionLoopState.repositories.map((repo) => repo.path));
    const nextWorkspaceView = workspaceViewFromMissionLoop(nextMissionLoopState);
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
    // Selection never auto-opens the panel: it survives a reload only while
    // its node still exists.
    setSelectedNodeId((current) => (nextWorkspaceView.graphNodes.some((node) => node.id === current) ? current : ""));
  };

  // applyRepoState folds a loaded state into the open set keyed by repo id,
  // then re-hydrates the canvas from the union — so adding or updating a repo
  // keeps the others.
  const applyRepoState = (state: MissionLoopState) => {
    const next = { ...repoStatesRef.current, ...splitByRepository(state) };
    repoStatesRef.current = next;
    hydrateMissionLoop(combineRepoStates(next));
  };

  // Merge one live-streamed record (run/event/patch/chat) into the workspace
  // and re-hydrate, so the canvas and transcript grow while the run is still
  // working instead of waiting for its final state snapshot.
  const mergeLiveRecord = (merge: (state: MissionLoopState) => MissionLoopState) => {
    const combined = combineRepoStates(repoStatesRef.current);
    const next = merge(combined);
    if (next !== combined) applyRepoState(next);
  };

  const closeRepo = (repositoryId: string) => {
    const { [repositoryId]: _removed, ...next } = repoStatesRef.current;
    repoStatesRef.current = next;
    hydrateMissionLoop(combineRepoStates(next));
  };

  // Open one repository into the workspace and remember it for the Recent
  // list. Shared by the path input, the folder browser, and the Recent picker.
  const openRepoAtPath = async (repoPath: string) => {
    setRefreshingMissionLoop(true);
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await openMissionLoopRepository(repoPath);
      setActiveRepoPath(repoPath);
      rememberRecentRepo(repoPath);
      applyRepoState(nextMissionLoopState);
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

      await openRepoAtPath(repoPath);
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to choose repository folder."));
    }
  };

  const loadDemoFactory = async () => {
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
        // Reopen the workspace the last session had open. A path that no
        // longer opens (moved/deleted repo) is dropped, not surfaced as an
        // error. Falls back to the demo load when nothing was open.
        const lastOpen = lastOpenRepoPaths();
        let reopened = false;
        for (const repoPath of lastOpen) {
          try {
            applyRepoState(await openMissionLoopRepository(repoPath));
            if (!reopened) {
              setActiveRepoPath(repoPath);
            }
            reopened = true;
          } catch (error) {
            console.error("[orbital] reopen failed", repoPath, error);
            forgetRecentRepo(repoPath);
          }
        }
        if (reopened) return;

        applyRepoState(await loadMissionLoopState(activeRepoPath));
      } catch (error) {
        setMissionLoopError(errorMessage(error, "Failed to load mission loop state."));
      } finally {
        setRefreshingMissionLoop(false);
      }
    };

    void loadMissionLoop();
    // Mount-only: loads the repo the session starts on; every later load is
    // driven by user actions through applyRepoState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc dismisses the topmost surface: modal → popover → draft card → panel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (diffModalOpen) {
        setDiffModalOpen(false);
        return;
      }
      if (repoHistory.openCommit) {
        repoHistory.close();
        return;
      }
      if (openPanel) {
        setOpenPanel(null);
        return;
      }
      if (modelPickerOpen) {
        setModelPickerOpen(false);
        return;
      }
      if (draftingTask) {
        setDraftingTask(false);
        return;
      }
      setSelectedNodeId("");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diffModalOpen, openPanel, modelPickerOpen, draftingTask, repoHistory]);

  return (
    <main className={`canvas-shell${selectedMission || selectedPlan || selectedRepoForPlan ? " panel-open" : ""}`}>
      <header className="topbar">
        <div className="topbar-brand">
          <CircleDot size={16} aria-hidden="true" />
          <span>Orbital</span>
        </div>

        <div className="topbar-repos">
          {missionLoopState.repositories.map((repo) => (
            <span key={repo.id} className={`repo-tab ${repo.path === activeRepoPath ? "active" : ""}`}>
              <button
                className="repo-tab-name"
                type="button"
                onClick={() => {
                  setActiveRepoPath(repo.path);
                }}
                title={repo.path}
              >
                {repo.name}
              </button>
              <button
                className="repo-close"
                type="button"
                onClick={() => closeRepo(repo.id)}
                title="Close repository"
                aria-label={`Close ${repo.name}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <button
            className="ghost icon-button"
            type="button"
            onClick={chooseWorkspaceFolder}
            disabled={refreshingMissionLoop}
            title="Open a repository"
            aria-label="Open a repository"
          >
            <FolderOpen size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="topbar-actions">
          {launchableCount > 1 ? (
            <button className="ghost mini-text" type="button" onClick={launchAllMissions} title="Launch every queued task in parallel">
              Run all
            </button>
          ) : null}
          <button
            className="ghost icon-button"
            type="button"
            onClick={() => setDraftingTask(true)}
            disabled={!draftRepository}
            title={draftRepository ? "Draft a task card on the canvas" : "Open a repository first"}
            aria-label="Draft a task card"
          >
            <Plus size={15} aria-hidden="true" />
          </button>
          <button
            className={`ghost icon-button ${openPanel === "mission" ? "active" : ""}`}
            type="button"
            onClick={() => togglePanel("mission")}
            title="Queue a backlog or multi-repo campaign"
            aria-label="Queue a backlog or campaign"
          >
            <Rocket size={14} aria-hidden="true" />
          </button>
          <button
            className={`ghost icon-button ${openPanel === "history" ? "active" : ""}`}
            type="button"
            onClick={() => togglePanel("history")}
            title="Git history"
            aria-label="Git history"
          >
            <History size={14} aria-hidden="true" />
          </button>
          <div className="topbar-model">
            <button
              type="button"
              className={`chip model-trigger ${modelPickerOpen ? "active" : ""}`}
              title="Model used by every AI run and chat turn"
              aria-haspopup="listbox"
              aria-expanded={modelPickerOpen}
              onClick={() => setModelPickerOpen((open) => !open)}
            >
              <Cpu size={14} aria-hidden="true" />
              <span>{modelName(claudeModel)}</span>
            </button>
            {modelPickerOpen ? (
              <div className="popover model-popover" role="listbox" aria-label="Claude model">
                {CURATED_MODELS.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={claudeModel === model.id}
                    className={`model-option ${claudeModel === model.id ? "active" : ""}`}
                    onClick={() => {
                      pickClaudeModel(model.id);
                      setModelPickerOpen(false);
                    }}
                  >
                    <span className="model-option-name">
                      {model.name}
                      {claudeModel === model.id ? <Check size={12} aria-hidden="true" /> : null}
                    </span>
                    <span className="model-option-blurb">{model.blurb}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="canvas-area">
        <GraphMap
          nodes={canvasNodes}
          edges={canvasEdges}
          selectedNodeId={selectedGraphNode?.id ?? ""}
          selectedMissionId={selectedMission?.id ?? ""}
          runningMissionIds={runningMissionIds}
          planningActive={planningRepoId !== ""}
          planFeed={planFeed}
          onSelectNode={handleSelectNode}
          actions={{
            onRunTask: (missionId) => void dispatchMission(missionId),
            onApprove: (missionId) => void approveMission(missionId),
            onReject: (missionId) => void rejectMission(missionId),
            onVerify: (missionId) => void runVerificationFor(missionId),
            onCreateTask: (text, run, kind, worker, model) => void createTaskOnCanvas(text, run, kind, worker, model),
            onPlanGoal: (text, model) => planGoalOnCanvas(text, model),
            onCancelDraft: () => setDraftingTask(false),
            onLinkTasks: (from, to) => void linkTasks(from, to),
            onUnlinkTasks: (from, to) => void unlinkTasks(from, to),
          }}
        />



      {openPanel === "mission" ? (
        <section className="popover mission-popover" aria-label="Queue tasks">
          <div className="section-label">Queue tasks</div>
          <textarea
            aria-label="Tasks to queue"
            placeholder={"One task per line — queue a whole backlog at once.\nadd a healthcheck endpoint\nupgrade the logging library\n…"}
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
              <option value="claude-engineer">Claude (AI)</option>
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
            {campaignTargetRepos().length > 1
              ? `Queue in ${campaignTargetRepos().length} repos`
              : `Queue ${missionDraft.split("\n").filter((line) => line.trim()).length > 1 ? "backlog" : "task"}`}
          </button>
        </section>
      ) : null}


      {openPanel === "history" ? (
        <section className="popover history-popover" aria-label="Git history">
          <div className="section-label">
            {selectedRepository?.name ?? "workspace"} · history
          </div>
          <HistoryPanel commits={repoHistory.commits} loading={repoHistory.loading} onSelect={(commit) => void repoHistory.open(commit)} />
        </section>
      ) : null}

        {missionLoopError ? <div className="floating-error">{missionLoopError}</div> : null}

        <PromptBar
          repoName={draftRepository?.name}
          repoPath={draftRepository?.path}
          planning={planningRepoId !== ""}
          planFeed={planFeed}
          onCreate={(text, attachments) => void createFromPrompt(text, attachments)}
          onPlan={(text, attachments) => planGoalOnCanvas(text + attachmentLines(attachments))}
          onResearch={(text, attachments) => void researchFromPrompt(text, attachments)}
        />

        {workspaceMissions.length === 0 ? (
          <div className="canvas-hint">
            <div className="canvas-hint-card">
              <span className="canvas-hint-title">
                {missionLoopState.repositories.length === 0 ? "No repository open" : "No tasks yet"}
              </span>
              <p>
                {missionLoopState.repositories.length === 0
                  ? "Open a repository to put it on the canvas."
                  : "Describe a task in the prompt bar below — an agent picks it up from there."}
              </p>
              {missionLoopState.repositories.length === 0 ? (
                <>
                  <button className="secondary" type="button" onClick={chooseWorkspaceFolder} disabled={refreshingMissionLoop}>
                    <FolderOpen size={14} aria-hidden="true" />
                    <span>Open repository</span>
                  </button>
                  {(() => {
                    // Recently opened repos — one click reopens.
                    const recent = recentRepoPaths();
                    if (recent.length === 0) return null;
                    return (
                      <ul className="canvas-hint-recent">
                        {recent.map((path) => (
                          <li key={path}>
                            <button
                              className="recent-repo"
                              type="button"
                              onClick={() => void openRepoAtPath(path)}
                              disabled={refreshingMissionLoop}
                              title={path}
                            >
                              <FolderOpen size={14} aria-hidden="true" />
                              <span className="workspace-repo-name">{repoNameFromPath(path)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    );
                  })()}
                  <button className="ghost mini-text" type="button" onClick={loadDemoFactory} disabled={refreshingMissionLoop}>
                    Demo
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {selectedPlan ? <PlanPanel plan={selectedPlan} taskCount={selectedPlanTaskCount} /> : null}

      {selectedRepoForPlan ? (
        <PlanIntake
          repoName={selectedRepoForPlan.name}
          planning={planningRepoId === selectedRepoForPlan.id}
          feed={planFeed}
          onPlan={(goal, format) => void planRepo(selectedRepoForPlan, goal, format)}
        />
      ) : null}

      {selectedMission ? (
        <aside className="inspector task-window" aria-label="Task">
          <section className="task-panel" aria-label="Task">
            <div className="panel-head review-head">
              <div>
                <div className="section-label">
                  {selectedRepository?.name ?? "workspace"} ·{" "}
                  {selectedMission.kind === "tool" ? "tool" : selectedMission.kind === "research" ? "research" : "task"}
                </div>
                <h2 className="work-order-title">{selectedMission.title}</h2>
              </div>
              <div className="task-head-actions">
                <div className={`mini-state ${missionStatus.className}`}>{missionStatus.label}</div>
                <button
                  className={`node-action secondary icon-button ${editingPrompt ? "active" : ""}`}
                  type="button"
                  onClick={editingPrompt ? () => setEditingPrompt(false) : beginEditPrompt}
                  disabled={selectedRuntime.status === "running"}
                  title="Edit this task's prompt"
                  aria-label="Edit prompt"
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
                <button
                  className="node-action secondary danger icon-button"
                  type="button"
                  onClick={() => void deleteMission(selectedMission.id)}
                  title="Remove this task"
                  aria-label="Remove task"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
                <button
                  className="node-action secondary icon-button"
                  type="button"
                  onClick={() => setSelectedNodeId("")}
                  title="Close panel (Esc)"
                  aria-label="Close panel"
                >
                  <X size={14} aria-hidden="true" />
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
              {selectedMission.kind === "research" ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={taskView === "doc"}
                  className={`task-switch-btn ${taskView === "doc" ? "active" : ""}`}
                  onClick={() => setTaskView("doc")}
                >
                  Document
                </button>
              ) : null}
              <button
                type="button"
                role="tab"
                aria-selected={taskView === "chat"}
                className={`task-switch-btn ${taskView === "chat" ? "active" : ""}`}
                onClick={() => setTaskView("chat")}
              >
                Chat
              </button>
              {selectedMission.kind !== "research" ? (
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
              ) : null}
              <div className="task-switch-spacer" />
            </div>

            <div className="task-body">
              {taskView === "doc" ? (
                <div className="plan-doc research-doc">
                  {researchDoc ? (
                    <DocumentView content={researchDoc} />
                  ) : (
                    <div className="diff-empty">
                      {selectedRuntime.status === "running"
                        ? "The researcher is reading the repo — findings land here."
                        : "No findings yet — run the research or ask it something in Chat."}
                    </div>
                  )}
                </div>
              ) : taskView === "chat" ? (
                <AgentChat
                  messages={selectedChatMessages}
                  statusModel={agentStatus}
                  transcript={agentTranscript}
                  files={agentStatus.files}
                  onOpenFile={(path) => {
                    setFocusedDiffFile(path);
                    setDiffModalOpen(true);
                  }}
                  sending={selectedChatSending}
                  onSend={(text) => void sendAgentChat(selectedMission.id, text)}
                  readOnly={selectedMission.kind === "tool"}
                  repoPath={selectedRepository?.path}
                />
              ) : (
                <div className="task-changes">
                  {agentStatus.files.length > 0 ? (
                    <ChangesCard
                      files={agentStatus.files}
                      onOpenFile={(path) => {
                        setFocusedDiffFile(path);
                        setDiffModalOpen(true);
                      }}
                    />
                  ) : (
                    <div className="diff-empty">
                      {patchReady
                        ? "No patch proposal captured for this task."
                        : "No changes yet — chat with the agent to make some."}
                    </div>
                  )}

                  {agentStatus.files.length > 0 && selectedMission.kind !== "tool" ? (
                    <ReviseBox
                      sending={selectedChatSending}
                      onSend={(text) => void sendAgentChat(selectedMission.id, text)}
                    />
                  ) : null}

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
                      onClick={() => void runVerificationFor(selectedMission.id)}
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
                      onClick={() => void rejectMission(selectedMission.id)}
                    >
                      <X size={16} aria-hidden="true" />
                      <span>Reject</span>
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={!patchReady || selectedRuntime.patchStatus !== "pending"}
                      onClick={() => void approveMission(selectedMission.id)}
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
            {patchReady && selectedMission.kind !== "tool" ? (
              <ReviseBox
                sending={selectedChatSending}
                onSend={(text) => void sendAgentChat(selectedMission.id, text)}
              />
            ) : null}
            <div className="actions">
              <button
                className="secondary"
                type="button"
                disabled={!patchReady || selectedRuntime.patchStatus !== "pending"}
                onClick={() => {
                  void rejectMission(selectedMission.id);
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
                  void approveMission(selectedMission.id);
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

      {repoHistory.openCommit ? (
        <div className="diff-modal-backdrop" onClick={repoHistory.close}>
          <div className="diff-modal" role="dialog" aria-label="Commit" onClick={(event) => event.stopPropagation()}>
            <div className="diff-modal-head">
              <div>
                <div className="section-label">
                  {selectedRepository?.name ?? "workspace"} · commit <code>{repoHistory.openCommit.short_hash}</code>
                </div>
                <h2>{repoHistory.openCommit.subject}</h2>
              </div>
              <button className="secondary icon-button" type="button" onClick={repoHistory.close} aria-label="Close">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <DiffView diff={repoHistory.commitDiff} emptyLabel="Loading commit…" />
          </div>
        </div>
      ) : null}
    </main>
  );
}

