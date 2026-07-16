import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { groupChatByMission } from "./agentTranscript";
import { errorMessage, workerModeFromName, type WorkerMode } from "./missionUi";
import { combineRepoStates, emptyMissionLoopState, splitByRepository } from "./repoStates";
import type { ChatMessage, MissionLoopState } from "./domain";
import { workspaceViewFromMissionLoop, type WorkspaceRuntimeMap } from "./workspaceAdapter";
import { openMissionLoopRepository } from "./missionLoopLoader";
import { forgetRecentRepo, lastOpenRepoPaths, persistOpenRepos, rememberRecentRepo } from "./recentRepos";

const initialWorkspaceView = workspaceViewFromMissionLoop(emptyMissionLoopState);

// Hydration knows whether the selected node survived the reload, so it takes the setter to clear a selection whose node disappeared.
export function useWorkspaceState(setSelectedNodeId: Dispatch<SetStateAction<string>>) {
  const [missionLoopState, setMissionLoopState] = useState(emptyMissionLoopState);
  // Each opened repository keeps its own worker state; the canvas renders the union of them all. Keyed by repository id.
  const repoStatesRef = useRef<Record<string, MissionLoopState>>({});
  const [refreshingMissionLoop, setRefreshingMissionLoop] = useState(false);
  const [missionLoopError, setMissionLoopError] = useState("");
  const [activeRepoPath, setActiveRepoPath] = useState("");
  const [workspaceMissions, setWorkspaceMissions] = useState(initialWorkspaceView.missions);
  const [workspaceGraphNodes, setWorkspaceGraphNodes] = useState(initialWorkspaceView.graphNodes);
  const [workspaceGraphEdges, setWorkspaceGraphEdges] = useState(initialWorkspaceView.graphEdges);
  const [runtimeByMission, setRuntimeByMission] = useState<WorkspaceRuntimeMap>(initialWorkspaceView.runtimeByMission);
  const [patchDiffByMission, setPatchDiffByMission] = useState(initialWorkspaceView.patchDiffByMission);
  const [commitByMission, setCommitByMission] = useState(initialWorkspaceView.commitByMission);
  const [verificationOutputByMission, setVerificationOutputByMission] = useState(initialWorkspaceView.verificationOutputByMission);
  const [activityByMission, setActivityByMission] = useState(initialWorkspaceView.activityByMission);
  const [verificationCommandByMission, setVerificationCommandByMission] = useState<Record<string, string>>(
    Object.fromEntries(initialWorkspaceView.missions.map((mission) => [mission.id, mission.command])),
  );
  const [workerModeByMission, setWorkerModeByMission] = useState<Record<string, WorkerMode>>(
    Object.fromEntries(initialWorkspaceView.missions.map((mission) => [mission.id, workerModeFromName(mission.worker)])),
  );
  const [chatByMission, setChatByMission] = useState<Record<string, ChatMessage[]>>({});
  const [chatSendingByMission, setChatSendingByMission] = useState<Record<string, boolean>>({});

  const hydrateMissionLoop = (nextMissionLoopState: MissionLoopState) => {
    persistOpenRepos(nextMissionLoopState.repositories.map((repo) => repo.path));
    const nextWorkspaceView = workspaceViewFromMissionLoop(nextMissionLoopState);
    setMissionLoopState(nextMissionLoopState);
    setWorkspaceMissions(nextWorkspaceView.missions);
    setWorkspaceGraphNodes(nextWorkspaceView.graphNodes);
    setWorkspaceGraphEdges(nextWorkspaceView.graphEdges);
    setRuntimeByMission(nextWorkspaceView.runtimeByMission);
    setPatchDiffByMission(nextWorkspaceView.patchDiffByMission);
    setCommitByMission(nextWorkspaceView.commitByMission);
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
    // Selection survives a reload only while its node still exists.
    setSelectedNodeId((current) => (nextWorkspaceView.graphNodes.some((node) => node.id === current) ? current : ""));
  };

  const applyRepoState = (state: MissionLoopState) => {
    const next = { ...repoStatesRef.current, ...splitByRepository(state) };
    repoStatesRef.current = next;
    hydrateMissionLoop(combineRepoStates(next));
  };

  // So the canvas and transcript grow while the run is still working, instead of waiting for its final state snapshot.
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

  // A path that no longer opens (moved/deleted repo) is dropped, not surfaced as an error.
  const reopenLastSession = async () => {
    setRefreshingMissionLoop(true);
    setMissionLoopError("");

    try {
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
    } catch (error) {
      setMissionLoopError(errorMessage(error, "Failed to load mission loop state."));
    } finally {
      setRefreshingMissionLoop(false);
    }
  };

  return {
    missionLoopState,
    refreshingMissionLoop,
    missionLoopError,
    setMissionLoopError,
    activeRepoPath,
    setActiveRepoPath,
    workspaceMissions,
    workspaceGraphNodes,
    workspaceGraphEdges,
    runtimeByMission,
    setRuntimeByMission,
    patchDiffByMission,
    commitByMission,
    verificationOutputByMission,
    activityByMission,
    verificationCommandByMission,
    setVerificationCommandByMission,
    workerModeByMission,
    setWorkerModeByMission,
    chatByMission,
    setChatByMission,
    chatSendingByMission,
    setChatSendingByMission,
    applyRepoState,
    mergeLiveRecord,
    closeRepo,
    openRepoAtPath,
    chooseWorkspaceFolder,
    reopenLastSession,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspaceState>;
