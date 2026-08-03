import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { GraphMap } from "./canvas/GraphMap";
import { TopBar } from "./shell/TopBar";
import { TaskPanel, loadPanelWidth } from "./review/TaskPanel";
import { DiffModal } from "./review/DiffModal";
import { DiffView } from "./review/DiffView";
import { PromptBar } from "./intake/PromptBar";
import { HistoryPanel } from "./shell/HistoryPanel";
import { CanvasEmptyState } from "./canvas/CanvasEmptyState";
import { buildAgentStatus } from "./chat/statusModel";
import { buildAgentTranscript, sliceTranscriptByMessage } from "./chat/transcriptModel";
import { missionStatusFor, queuedRuntime, repositoryFor } from "./workspace/missionUi";
import { followUpTargetFor } from "./workspace/workspaceAdapter";
import { buildCanvasEdges, buildCanvasNodes, enrichGraphNodes } from "./canvas/canvasView";
import { findModel, resolveEffort } from "./workspace/models";
import { useModelCatalog } from "./workspace/useModels";
import { useWorkspaceState } from "./workspace/useWorkspaceState";
import { useMissionActions } from "./workspace/useMissionActions";
import { useRepoHistory } from "./workspace/useRepoHistory";

// Exists only in the rendered graph until Create/Run turns it into a real mission, so one well-known id is enough.
const DRAFT_TASK_NODE_ID = "task_draft";

export function App() {
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const workspace = useWorkspaceState(setSelectedNodeId);
  const {
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
    activityByMission,
    usageByMission,
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
  } = workspace;

  // Dismissal is per-selection, so picking a different mission brings the follow-up chip back.
  const [followUpDismissedFor, setFollowUpDismissedFor] = useState("");
  const [taskView, setTaskView] = useState<"chat" | "changes">("chat");
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [focusedDiffFile, setFocusedDiffFile] = useState<string | undefined>(undefined);
  // Model and effort are derived, not stored: an explicit pick here wins, and
  // with nothing picked they follow whatever Claude Code itself is configured
  // to use. Deriving (rather than seeding state in an effect) is what lets the
  // catalog arrive asynchronously without a setState-in-effect.
  const modelCatalog = useModelCatalog();
  const [modelPick, setModelPick] = useState(() => localStorage.getItem("orbital:model") ?? "");
  const [effortPick, setEffortPick] = useState(() => localStorage.getItem("orbital:effort") ?? "");
  const claudeModel = modelPick || modelCatalog.defaultModel;
  // Effort is filtered through the selected model, so a level it doesn't offer
  // is never sent (Haiku takes none at all, and gets an empty string).
  const claudeEffort = resolveEffort(
    effortPick || modelCatalog.defaultEffort,
    findModel(modelCatalog.models, claudeModel),
  );
  const pickClaudeModel = (model: string) => {
    setModelPick(model);
    localStorage.setItem("orbital:model", model);
  };
  const pickClaudeEffort = (effort: string) => {
    setEffortPick(effort);
    localStorage.setItem("orbital:effort", effort);
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  // Panel width lives here (not in TaskPanel) because the prompt bar centers itself around the panel via the --task-panel-width CSS var on the shell.
  const [taskPanelWidth, setTaskPanelWidth] = useState(loadPanelWidth);
  const [draftingTask, setDraftingTask] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const repoHistory = useRepoHistory(activeRepoPath);

  const handleSelectNode = (nodeId: string) => {
    // The draft card is an input surface, not a mission — clicking it while typing must not steal the selection onto some other node.
    if (nodeId === DRAFT_TASK_NODE_ID) return;
    setSelectedNodeId(nodeId);
    const node = workspaceGraphNodes.find((item) => item.id === nodeId);
    if (!node) return;
    switch (node.kind) {
      case "task":
      case "tool":
        setTaskView("chat");
        break;
      default:
        break;
    }
  };

  // The panel is mission-scoped, so repo and campaign nodes never open it.
  const selectedGraphNode = workspaceGraphNodes.find((node) => node.id === selectedNodeId);
  const selectedMissionId = selectedGraphNode?.mission_id;
  const selectedMission = workspaceMissions.find((mission) => mission.id === selectedMissionId);
  // The raw mission record carries the untouched text (attachments included); the WorkspaceMission's title/prompt are the cleaned display versions.
  const selectedMissionRecord = missionLoopState.missions.find((mission) => mission.id === selectedMission?.id);
  const selectedRepository = selectedMission ? repositoryFor(selectedMission, missionLoopState.repositories) : undefined;
  const followUpTarget =
    followUpDismissedFor === selectedNodeId ? undefined : followUpTargetFor(selectedGraphNode, workspaceMissions);
  const selectedRuntime = (selectedMission ? runtimeByMission[selectedMission.id] : undefined) ?? queuedRuntime;
  const selectedPatchDiff = (selectedMission ? patchDiffByMission[selectedMission.id] : undefined) ?? "";
  const selectedCommit = (selectedMission ? commitByMission[selectedMission.id] : undefined) ?? { hash: "", subject: "", branch: "" };
  const patchReady = (selectedPatchDiff ?? "") !== "";

  // The mission is one card, so its chat is the whole mission's transcript — every run it has had, in order.
  const agentTranscript = useMemo(
    () => buildAgentTranscript(missionLoopState, selectedMissionId ?? ""),
    [missionLoopState, selectedMissionId],
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
  const selectedChatMessages = useMemo(
    () => chatByMission[selectedMission?.id ?? ""] ?? [],
    [chatByMission, selectedMission?.id],
  );
  const selectedChatSending = chatSendingByMission[selectedMission?.id ?? ""] ?? false;
  // Each assistant message's own slice of the mission's reasoning, pinned to its footer in chat.
  const reasoningByMessage = useMemo(
    () => sliceTranscriptByMessage(missionLoopState, selectedMissionId ?? "", selectedChatMessages),
    [missionLoopState, selectedMissionId, selectedChatMessages],
  );

  // Render-phase reset (the React "adjust state on prop change" pattern) instead of an effect, so an unsaved draft never leaks onto a different mission.
  const [editorMissionId, setEditorMissionId] = useState(selectedMissionId);
  if (editorMissionId !== selectedMissionId) {
    setEditorMissionId(selectedMissionId);
    setEditingPrompt(false);
    setTaskView("chat");
  }


  const draftRepository =
    selectedRepository ??
    missionLoopState.repositories.find((repo) => repo.path === activeRepoPath) ??
    missionLoopState.repositories[0];

  const missionActions = useMissionActions({
    workspaceMissions,
    repositories: missionLoopState.repositories,
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
    setDraftingTask,
    setEditingPrompt,
  });
  const {
    runningMissionIds,
    createTaskOnCanvas,
    linkTasks,
    unlinkTasks,
    createFromPrompt,
    dispatchMission,
    sendAgentChat,
    approveMission,
    rejectMission,
    deleteMission,
    saveMissionPrompt,
  } = missionActions;

  const beginEditPrompt = () => {
    setPromptDraft(selectedMissionRecord?.text ?? selectedMission?.prompt ?? "");
    setEditingPrompt(true);
  };

  const toggleHistory = () =>
    setHistoryOpen((current) => {
      // History reads git fresh on every open, so landed patches show up.
      if (!current) void repoHistory.refresh();
      return !current;
    });

  const graphNodes = useMemo(
    () =>
      enrichGraphNodes({
        workspaceGraphNodes,
        workspaceMissions,
        runtimeByMission,
        workerModeByMission,
        activityByMission,
        patchDiffByMission,
        usageByMission,
      }),
    [
      runtimeByMission,
      workspaceGraphNodes,
      workspaceMissions,
      workerModeByMission,
      activityByMission,
      patchDiffByMission,
      usageByMission,
    ],
  );

  const graphEdges = workspaceGraphEdges;

  const canvasNodes = useMemo(
    () => buildCanvasNodes(graphNodes, draftingTask, DRAFT_TASK_NODE_ID, draftRepository?.id),
    [graphNodes, draftingTask, draftRepository?.id],
  );

  const canvasEdges = useMemo(
    () => buildCanvasEdges(graphEdges, draftingTask, DRAFT_TASK_NODE_ID, draftRepository),
    [graphEdges, draftingTask, draftRepository],
  );

  useEffect(() => {
    void reopenLastSession();
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
      if (historyOpen) {
        setHistoryOpen(false);
        return;
      }
      if (modelPickerOpen) {
        setModelPickerOpen(false);
        return;
      }
      if (effortPickerOpen) {
        setEffortPickerOpen(false);
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
  }, [diffModalOpen, historyOpen, modelPickerOpen, effortPickerOpen, draftingTask, repoHistory]);

  // Canvas keybinds for the selected node. Delete/Backspace removes it: a
  // mission node runs the panel's confirm-and-delete flow; a repo node closes
  // the project (same as its TopBar tab X). Enter opens a mission's task panel.
  // Never while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target != null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      const deleteKey = event.key === "Delete" || event.key === "Backspace";
      if (deleteKey && selectedGraphNode?.kind === "repo" && selectedGraphNode.repository_id) {
        event.preventDefault();
        if (window.confirm(`Remove "${selectedGraphNode.label}" from the canvas? Its tasks and runs stay on disk.`)) {
          closeRepo(selectedGraphNode.repository_id);
        }
        return;
      }
      if (!selectedMission) return;
      if (deleteKey) {
        event.preventDefault();
        void deleteMission(selectedMission.id);
      } else if (event.key === "Enter") {
        event.preventDefault();
        handleSelectNode(selectedNodeId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // handleSelectNode is a plain closure, recreated every render — re-subscribing is cheap and correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMission, selectedGraphNode, selectedNodeId, deleteMission, closeRepo]);

  return (
    <main
      className={`canvas-shell${selectedMission ? " panel-open" : ""}`}
      style={{ "--task-panel-width": `${taskPanelWidth}px` } as CSSProperties}
    >
      <TopBar
        repositories={missionLoopState.repositories}
        activeRepoPath={activeRepoPath}
        onSelectRepo={setActiveRepoPath}
        onCloseRepo={closeRepo}
        onChooseFolder={chooseWorkspaceFolder}
        refreshing={refreshingMissionLoop}
        draftRepositoryAvailable={Boolean(draftRepository)}
        onDraftTask={() => setDraftingTask(true)}
        historyOpen={historyOpen}
        onToggleHistory={toggleHistory}
      />

      <div className="canvas-area">
        <GraphMap
          nodes={canvasNodes}
          edges={canvasEdges}
          selectedNodeId={selectedGraphNode?.id ?? ""}
          selectedMissionId={selectedMission?.id ?? ""}
          runningMissionIds={runningMissionIds}
          onSelectNode={handleSelectNode}
          actions={{
            onRunTask: (missionId) => void dispatchMission(missionId),
            onApprove: (missionId) => void approveMission(missionId),
            onReject: (missionId) => void rejectMission(missionId),
            onCreateTask: (text, run, kind, worker, model) => void createTaskOnCanvas(text, run, kind, worker, model),
            onCancelDraft: () => setDraftingTask(false),
            onLinkTasks: (from, to) => void linkTasks(from, to),
            onUnlinkTasks: (from, to) => void unlinkTasks(from, to),
          }}
        />

      {historyOpen ? (
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
          followUp={followUpTarget}
          onDismissFollowUp={() => setFollowUpDismissedFor(selectedNodeId)}
          onCreate={(text, attachments) => void createFromPrompt(text, attachments)}
          claudeModel={claudeModel}
          onPickModel={(model) => {
            pickClaudeModel(model);
            setModelPickerOpen(false);
          }}
          modelPickerOpen={modelPickerOpen}
          onToggleModelPicker={() => setModelPickerOpen((open) => !open)}
          claudeEffort={claudeEffort}
          onPickEffort={(effort) => {
            pickClaudeEffort(effort);
            setEffortPickerOpen(false);
          }}
          effortPickerOpen={effortPickerOpen}
          onToggleEffortPicker={() => setEffortPickerOpen((open) => !open)}
        />

        {workspaceMissions.length === 0 ? (
          <CanvasEmptyState
            hasRepositories={missionLoopState.repositories.length > 0}
            refreshing={refreshingMissionLoop}
            onChooseFolder={chooseWorkspaceFolder}
            onOpenRepoAtPath={(path) => void openRepoAtPath(path)}
          />
        ) : null}
      </div>

      {selectedMission ? (
        <TaskPanel
          mission={selectedMission}
          repository={selectedRepository}
          missionStatus={missionStatus}
          runtime={selectedRuntime}
          editingPrompt={editingPrompt}
          onBeginEditPrompt={beginEditPrompt}
          onCancelEditPrompt={() => setEditingPrompt(false)}
          promptDraft={promptDraft}
          onChangePromptDraft={setPromptDraft}
          onSavePrompt={() => void saveMissionPrompt(selectedMission.id, promptDraft)}
          onDelete={() => void deleteMission(selectedMission.id)}
          onClose={() => setSelectedNodeId("")}
          onWidthChange={setTaskPanelWidth}
          taskView={taskView}
          onChangeTaskView={setTaskView}
          agentStatus={agentStatus}
          patchReady={patchReady}
          commit={selectedCommit}
          chatMessages={selectedChatMessages}
          chatSending={selectedChatSending}
          agentTranscript={agentTranscript}
          reasoningByMessage={reasoningByMessage}
          onOpenDiffFile={(path) => {
            setFocusedDiffFile(path);
            setDiffModalOpen(true);
          }}
          onSendChat={(text) => void sendAgentChat(selectedMission.id, text)}
          onReject={() => void rejectMission(selectedMission.id)}
          onApprove={() => void approveMission(selectedMission.id)}
        />
      ) : null}

      {diffModalOpen && selectedMission ? (
        <DiffModal
          mission={selectedMission}
          repository={selectedRepository}
          runtime={selectedRuntime}
          patchReady={patchReady}
          patchDiff={selectedPatchDiff}
          focusedDiffFile={focusedDiffFile}
          chatSending={selectedChatSending}
          onSendChat={(text) => void sendAgentChat(selectedMission.id, text)}
          onClose={() => setDiffModalOpen(false)}
          onReject={() => {
            void rejectMission(selectedMission.id);
            setDiffModalOpen(false);
          }}
          onApprove={() => {
            void approveMission(selectedMission.id);
            setDiffModalOpen(false);
          }}
        />
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
