import { useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { attachmentLines } from "../intake/attachments";
import {
  defaultLocalCommand,
  errorMessage,
  queuedRuntime,
  workerModeFromName,
  type WorkerMode,
} from "./missionUi";
import { mergeChatMessage, mergeWorkflowEvent, upsertAgentRun, upsertPatchProposal } from "./repoStates";
import type { AgentRun, ChatMessage, MissionLoopState, PatchProposal, Repository, WorkflowEvent } from "./domain";
import type { WorkspaceMission } from "../canvas/graph";
import { forgetNodePosition } from "../canvas/nodePositions";
import type { WorkspaceRuntimeMap } from "./workspaceAdapter";
import {
  amendCommitMissionLoopState,
  approvePatchMissionLoopState,
  deleteMissionLoopState,
  linkMissionsLoopState,
  queueMissionLoopState,
  rejectPatchMissionLoopState,
  sendAgentMessageLoopState,
  startAgentRunMissionLoopState,
  unlinkMissionsLoopState,
  updateMissionTextLoopState,
} from "./missionLoopLoader";

const freshId = (prefix: string) => `${prefix}_${Date.now()}`;

export type UseMissionActionsArgs = {
  workspaceMissions: WorkspaceMission[];
  repositories: Repository[];
  activeRepoPath: string;
  draftRepository: Repository | undefined;
  runtimeByMission: WorkspaceRuntimeMap;
  setRuntimeByMission: Dispatch<SetStateAction<WorkspaceRuntimeMap>>;
  workerModeByMission: Record<string, WorkerMode>;
  setWorkerModeByMission: Dispatch<SetStateAction<Record<string, WorkerMode>>>;
  setChatByMission: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
  setChatSendingByMission: Dispatch<SetStateAction<Record<string, boolean>>>;
  applyRepoState: (state: MissionLoopState) => void;
  mergeLiveRecord: (merge: (state: MissionLoopState) => MissionLoopState) => void;
  setMissionLoopError: Dispatch<SetStateAction<string>>;
  claudeModel: string;
  claudeEffort: string;
  followUpTarget: { id: string; title: string } | undefined;
  setEditingPrompt: Dispatch<SetStateAction<boolean>>;
};

export function useMissionActions({
  workspaceMissions,
  repositories,
  activeRepoPath,
  draftRepository,
  runtimeByMission,
  setRuntimeByMission,
  workerModeByMission,
  setWorkerModeByMission,
  setChatByMission,
  setChatSendingByMission,
  applyRepoState,
  mergeLiveRecord,
  setMissionLoopError,
  claudeModel,
  claudeEffort,
  followUpTarget,
  setEditingPrompt,
}: UseMissionActionsArgs) {
  // Dispatch promise rejects when a cancelled mission's agent process dies; swallowed instead of surfaced as an error.
  const cancelledMissionsRef = useRef<Set<string>>(new Set());
  // The model a mission runs on lives on the mission itself (persisted by the
  // worker), so it survives a reload. The global picker only supplies it at
  // creation time and is the fallback for missions created before the choice
  // was recorded.
  const modelForMission = (missionId: string) =>
    workspaceMissions.find((mission) => mission.id === missionId)?.model || claudeModel;

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

  // Mission is already queued by the time this runs, so a link failure is reported but never undoes the creation.
  const linkFollowUp = async (repoPath: string, newMissionId: string) => {
    if (!followUpTarget) return;
    try {
      applyRepoState(await linkMissionsLoopState(repoPath, followUpTarget.id, newMissionId));
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to link follow-up."));
    }
  };

  // One prompt, one task — line breaks are part of what the task says, not a
  // separator that silently multiplies it.
  const createFromPrompt = async (text: string, attachments: string[]) => {
    if (!draftRepository) return;
    setMissionLoopError("");
    const prompt = text.trim();
    if (!prompt) return;
    try {
      const nextMissionLoopState = await queueMissionLoopState(
        draftRepository.path,
        prompt + attachmentLines(attachments),
        undefined,
        undefined,
        claudeModel,
      );
      const missionId = nextMissionLoopState.missions.at(-1)?.id;
      applyRepoState(nextMissionLoopState);
      if (missionId) {
        setWorkerModeByMission((current) => ({ ...current, [missionId]: "claude-engineer" }));
        await linkFollowUp(draftRepository.path, missionId);
      }
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to create task."));
    }
  };

  const runningMissionIds = useMemo(
    () => new Set(workspaceMissions.filter((m) => runtimeByMission[m.id]?.status === "running").map((m) => m.id)),
    [workspaceMissions, runtimeByMission],
  );

  const repoPathForMission = (missionId: string) => {
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const repository = mission ? repositories.find((repo) => repo.id === mission.repository_id) : undefined;
    return repository?.path ?? activeRepoPath;
  };

  // Overrides cover missions created a moment ago whose state isn't in this closure yet.
  const dispatchMission = async (missionId: string, overrides?: { repoPath?: string; workerMode?: WorkerMode; model?: string }) => {
    setMissionLoopError("");
    const repoPath = overrides?.repoPath ?? repoPathForMission(missionId);
    const mission = workspaceMissions.find((item) => item.id === missionId);
    const workerMode = overrides?.workerMode ?? workerModeByMission[missionId] ?? workerModeFromName(mission?.worker);
    const runModel = overrides?.model ?? modelForMission(missionId);
    const localCommand = defaultLocalCommand();

    setRuntimeByMission((current) => ({
      ...current,
      [missionId]: {
        ...(current[missionId] ?? queuedRuntime),
        status: "running",
        step: Math.max(current[missionId]?.step ?? -1, 0),
        // A re-run answers the last failure: drop its reason as the new run starts.
        blockedReason: undefined,
      },
    }));

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
        claudeEffort,
      );
      applyRepoState(nextMissionLoopState);
      // A tool mission lands the moment its command exits cleanly, with no approve gate to fire the chain from, so downstream tasks release here.
      // AI missions end a run in waiting_approval, making this a no-op; their cascade stays with approveMission.
      const finished = nextMissionLoopState.missions.find((mission) => mission.id === missionId);
      if (finished && ["approved", "applied", "verified"].includes(finished.status)) {
        autoDispatchChained(missionId, nextMissionLoopState);
      }
    } catch (error) {
      // A delete kills the run mid-flight, which rejects here — expected, not a failure to surface.
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

  // First turn starts a live claude session; every later turn resumes it, so the agent keeps its context and its diff evolves in place.
  const sendAgentChat = async (missionId: string, text: string) => {
    setMissionLoopError("");
    const repoPath = repoPathForMission(missionId);

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
      applyRepoState(await sendAgentMessageLoopState(repoPath, missionId, text, modelForMission(missionId), claudeEffort));
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

  // message is what the gate's commit box holds; it becomes the commit message.
  const approveMission = async (missionId: string, message = "") => {
    setMissionLoopError("");

    try {
      const nextMissionLoopState = await approvePatchMissionLoopState(repoPathForMission(missionId), missionId, message);
      applyRepoState(nextMissionLoopState);
      autoDispatchChained(missionId, nextMissionLoopState);
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to approve patch."));
    }
  };

  // Rewords the commit a mission landed. Fails loudly (rather than silently
  // rewriting history) once another commit sits on top — that guard is the
  // worker's, and its message is what the user sees.
  const amendMissionCommit = async (missionId: string, message: string) => {
    setMissionLoopError("");

    try {
      applyRepoState(await amendCommitMissionLoopState(repoPathForMission(missionId), missionId, message));
      return true;
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to amend the commit."));
      return false;
    }
  };

  // Every mission that depends on the landed one — and whose other upstreams have all landed too — dispatches automatically.
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
      // Only tasks that never ran wait in "draft"; anything else already started (or finished) and must not be re-fired.
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
      forgetNodePosition(missionId);
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to delete mission."));
    } finally {
      cancelledMissionsRef.current.delete(missionId);
    }
  };

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

  return {
    runningMissionIds,
    linkTasks,
    unlinkTasks,
    createFromPrompt,
    repoPathForMission,
    dispatchMission,
    sendAgentChat,
    approveMission,
    amendMissionCommit,
    rejectMission,
    deleteMission,
    saveMissionPrompt,
  };
}
