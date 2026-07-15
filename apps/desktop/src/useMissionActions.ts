// Every mutation a mission can go through: creation (canvas draft, prompt bar,
// backlog intake), dispatch and chat, and the approve/reject/verify/delete
// gates. Reads the workspace maps it needs and writes back through the
// setters useWorkspaceState hands out — it owns no mission-loop state itself,
// only the intake state scoped to authoring a new mission.
import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { attachmentLines } from "./attachments";
import {
  defaultLocalCommand,
  errorMessage,
  queuedRuntime,
  workerModeFromName,
  type WorkerMode,
} from "./missionUi";
import { mergeChatMessage, mergeWorkflowEvent, upsertAgentRun, upsertPatchProposal } from "./repoStates";
import type { AgentRun, ChatMessage, MissionLoopState, PatchProposal, Repository, WorkflowEvent } from "./domain";
import type { WorkspaceMission } from "./graph";
import type { WorkspaceRuntimeMap } from "./workspaceAdapter";
import {
  approvePatchMissionLoopState,
  deleteMissionLoopState,
  extractTasksLoopState,
  linkMissionsLoopState,
  queueMissionLoopState,
  rejectPatchMissionLoopState,
  sendAgentMessageLoopState,
  startAgentRunMissionLoopState,
  unlinkMissionsLoopState,
  updateMissionTextLoopState,
  verifyMissionLoopState,
} from "./missionLoopLoader";

// Unique-enough id for optimistic records and campaign grouping.
const freshId = (prefix: string) => `${prefix}_${Date.now()}`;

export type UseMissionActionsArgs = {
  workspaceMissions: WorkspaceMission[];
  repositories: Repository[];
  activeRepoPath: string;
  selectedRepository: Repository | undefined;
  draftRepository: Repository | undefined;
  runtimeByMission: WorkspaceRuntimeMap;
  setRuntimeByMission: Dispatch<SetStateAction<WorkspaceRuntimeMap>>;
  workerModeByMission: Record<string, WorkerMode>;
  setWorkerModeByMission: Dispatch<SetStateAction<Record<string, WorkerMode>>>;
  verificationCommandByMission: Record<string, string>;
  setChatByMission: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
  setChatSendingByMission: Dispatch<SetStateAction<Record<string, boolean>>>;
  applyRepoState: (state: MissionLoopState) => void;
  mergeLiveRecord: (merge: (state: MissionLoopState) => MissionLoopState) => void;
  setMissionLoopError: Dispatch<SetStateAction<string>>;
  claudeModel: string;
  followUpTarget: { id: string; title: string } | undefined;
  setDraftingTask: Dispatch<SetStateAction<boolean>>;
  setEditingPrompt: Dispatch<SetStateAction<boolean>>;
};

export function useMissionActions({
  workspaceMissions,
  repositories,
  activeRepoPath,
  selectedRepository,
  draftRepository,
  runtimeByMission,
  setRuntimeByMission,
  workerModeByMission,
  setWorkerModeByMission,
  verificationCommandByMission,
  setChatByMission,
  setChatSendingByMission,
  applyRepoState,
  mergeLiveRecord,
  setMissionLoopError,
  claudeModel,
  followUpTarget,
  setDraftingTask,
  setEditingPrompt,
}: UseMissionActionsArgs) {
  // Missions whose in-flight run we intentionally killed (via delete). Their
  // dispatch promise rejects when the agent process dies — we swallow that
  // instead of flashing it as an error.
  const cancelledMissionsRef = useRef<Set<string>>(new Set());
  const [missionDraft, setMissionDraft] = useState("");
  // Research missions with an extraction pass in flight — disables the
  // "Create tasks" button and shows its busy label.
  const [extractingByMission, setExtractingByMission] = useState<Record<string, boolean>>({});
  // Repos a queued intent fans out to. Picking >1 makes it a coordinated
  // campaign: the same intent is queued in each repo under a shared campaign id.
  const [campaignRepoIds, setCampaignRepoIds] = useState<string[]>([]);
  // Worker chosen at launch time (intake), applied to every mission queued.
  const [intakeWorkerMode, setIntakeWorkerMode] = useState<WorkerMode>("claude-engineer");
  // Per-mission model overrides, chosen on the intake card. Missions without
  // an entry follow the global pick.
  const [modelByMission, setModelByMission] = useState<Record<string, string>>({});

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

  // Chain a freshly queued mission after the prompt bar's active follow-up
  // target, if any. The mission is already queued by the time this runs, so a
  // link failure is reported but never undoes the creation.
  const linkFollowUp = async (repoPath: string, newMissionId: string) => {
    if (!followUpTarget) return;
    try {
      applyRepoState(await linkMissionsLoopState(repoPath, followUpTarget.id, newMissionId));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to link follow-up."));
    }
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
      if (missionId) {
        await linkFollowUp(draftRepository.path, missionId);
        void dispatchMission(missionId, { repoPath: draftRepository.path });
      }
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
          await linkFollowUp(draftRepository.path, missionId);
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
    const repository = mission ? repositories.find((repo) => repo.id === mission.repository_id) : undefined;
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

  // Turn a research mission's findings into draft tasks chained after it.
  const extractTasks = async (missionId: string) => {
    if (extractingByMission[missionId]) return;
    setMissionLoopError("");
    setExtractingByMission((current) => ({ ...current, [missionId]: true }));

    try {
      applyRepoState(await extractTasksLoopState(repoPathForMission(missionId), missionId));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to create tasks from the research document."));
    } finally {
      setExtractingByMission((current) => ({ ...current, [missionId]: false }));
    }
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

  return {
    missionDraft,
    setMissionDraft,
    campaignRepoIds,
    setCampaignRepoIds,
    intakeWorkerMode,
    setIntakeWorkerMode,
    runningMissionIds,
    launchableCount,
    createTaskOnCanvas,
    linkTasks,
    unlinkTasks,
    researchFromPrompt,
    createFromPrompt,
    missionIsLaunchable,
    repoPathForMission,
    launchAllMissions,
    dispatchMission,
    sendAgentChat,
    queueMission,
    campaignTargetRepos,
    toggleCampaignRepo,
    approveMission,
    rejectMission,
    deleteMission,
    saveMissionPrompt,
    runVerificationFor,
    extractingByMission,
    extractTasks,
  };
}
