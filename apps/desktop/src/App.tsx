import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { GraphMap } from "./components/GraphMap";
import { TopBar } from "./components/TopBar";
import { TaskPanel, loadPanelWidth } from "./components/TaskPanel";
import { DiffModal } from "./components/DiffModal";
import { DiffView } from "./components/DiffView";
import { PromptBar } from "./components/PromptBar";
import { HistoryPanel } from "./components/HistoryPanel";
import { QueueIntakePanel } from "./components/QueueIntakePanel";
import { CanvasEmptyState } from "./components/CanvasEmptyState";
import { buildAgentStatus } from "./agentStatus";
import { buildAgentTranscript, sliceTranscriptByMessage } from "./agentTranscript";
import { missionStatusFor, queuedRuntime, repositoryFor } from "./missionUi";
import { followUpTargetFor } from "./workspaceAdapter";
import { buildCanvasEdges, buildCanvasNodes, enrichGraphNodes } from "./canvasView";
import { useWorkspaceState } from "./useWorkspaceState";
import { useMissionActions } from "./useMissionActions";
import { useRepoHistory } from "./useRepoHistory";

// Exists only in the rendered graph until Queue/Run turns it into a real mission, so one well-known id is enough.
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
  } = workspace;

  // Dismissal is per-selection, so picking a different mission brings the follow-up chip back.
  const [followUpDismissedFor, setFollowUpDismissedFor] = useState("");
  // Research missions show "doc" (the findings document) instead of "changes".
  const [taskView, setTaskView] = useState<"chat" | "changes" | "doc">("chat");
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [focusedDiffFile, setFocusedDiffFile] = useState<string | undefined>(undefined);
  // Empty string means the claude CLI's own default.
  const [claudeModel, setClaudeModel] = useState(() => localStorage.getItem("orbital:model") ?? "");
  const pickClaudeModel = (model: string) => {
    setClaudeModel(model);
    localStorage.setItem("orbital:model", model);
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Panel width lives here (not in TaskPanel) because the prompt bar centers itself around the panel via the --task-panel-width CSS var on the shell.
  const [taskPanelWidth, setTaskPanelWidth] = useState(loadPanelWidth);
  const [draftingTask, setDraftingTask] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [openPanel, setOpenPanel] = useState<null | "mission" | "history">(null);
  const repoHistory = useRepoHistory(activeRepoPath);

  const handleSelectNode = (nodeId: string) => {
    // The draft card is an input surface, not a mission — clicking it while typing must not steal the selection onto some other node.
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
  const selectedVerificationOutput = (selectedMission ? verificationOutputByMission[selectedMission.id] : undefined) ?? "";
  const selectedVerificationCommand = (selectedMission ? verificationCommandByMission[selectedMission.id] : undefined) ?? selectedMission?.command ?? "";
  const patchReady = (selectedPatchDiff ?? "") !== "";

  // A clicked child agent uses its own run id; the manager node uses the mission's top-level run; otherwise the whole mission's agents are shown together.
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
    setTaskView(selectedMission?.kind === "research" ? "doc" : "chat");
  }

  // Missions from before the document field existed fall back to the latest assistant reply.
  const researchDoc =
    selectedMission?.kind === "research"
      ? selectedMissionRecord?.document ??
        [...selectedChatMessages].reverse().find((message) => message.role === "assistant")?.text ??
        ""
      : "";

  const draftRepository =
    selectedRepository ??
    missionLoopState.repositories.find((repo) => repo.path === activeRepoPath) ??
    missionLoopState.repositories[0];

  const missionActions = useMissionActions({
    workspaceMissions,
    repositories: missionLoopState.repositories,
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
  });
  const {
    missionDraft,
    setMissionDraft,
    setCampaignRepoIds,
    intakeWorkerMode,
    setIntakeWorkerMode,
    runningMissionIds,
    createTaskOnCanvas,
    linkTasks,
    unlinkTasks,
    researchFromPrompt,
    createFromPrompt,
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
  } = missionActions;
  const selectedExtractingTasks = extractingByMission[selectedMission?.id ?? ""] ?? false;

  const beginEditPrompt = () => {
    setPromptDraft(selectedMissionRecord?.text ?? selectedMission?.prompt ?? "");
    setEditingPrompt(true);
  };

  const togglePanel = (panel: "mission" | "history") =>
    setOpenPanel((current) => {
      const next = current === panel ? null : panel;
      // Opening intake starts from the current repo; campaign targets are opt-in.
      if (next === "mission") setCampaignRepoIds([]);
      // History reads git fresh on every open, so landed patches show up.
      if (next === "history") void repoHistory.refresh();
      return next;
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
        verificationOutputByMission,
        verificationCommandByMission,
        commitByMission,
      }),
    [
      runtimeByMission,
      workspaceGraphNodes,
      workspaceMissions,
      workerModeByMission,
      activityByMission,
      patchDiffByMission,
      verificationOutputByMission,
      verificationCommandByMission,
      commitByMission,
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

  // Canvas keybinds for the selected mission node: Delete/Backspace removes it
  // (same confirm-and-call flow as the panel's Trash button), Enter opens its
  // task panel (same as clicking it). Never while typing — repo/campaign
  // nodes have no selectedMission, so they're naturally exempt.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target != null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing || !selectedMission) return;
      if (event.key === "Delete" || event.key === "Backspace") {
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
  }, [selectedMission, selectedNodeId, deleteMission]);

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
        openPanel={openPanel}
        onTogglePanel={togglePanel}
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
            onVerify: (missionId) => void runVerificationFor(missionId),
            onCreateTask: (text, run, kind, worker, model) => void createTaskOnCanvas(text, run, kind, worker, model),
            onCancelDraft: () => setDraftingTask(false),
            onLinkTasks: (from, to) => void linkTasks(from, to),
            onUnlinkTasks: (from, to) => void unlinkTasks(from, to),
          }}
        />

      {openPanel === "mission" ? (
        <QueueIntakePanel
          repositories={missionLoopState.repositories}
          missionDraft={missionDraft}
          onChangeMissionDraft={setMissionDraft}
          campaignTargetRepos={campaignTargetRepos}
          onToggleCampaignRepo={toggleCampaignRepo}
          intakeWorkerMode={intakeWorkerMode}
          onChangeIntakeWorkerMode={setIntakeWorkerMode}
          onQueue={() => {
            void queueMission();
            setOpenPanel(null);
          }}
        />
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
          followUp={followUpTarget}
          onDismissFollowUp={() => setFollowUpDismissedFor(selectedNodeId)}
          onCreate={(text, attachments) => void createFromPrompt(text, attachments)}
          onResearch={(text, attachments) => void researchFromPrompt(text, attachments)}
          claudeModel={claudeModel}
          onPickModel={(model) => {
            pickClaudeModel(model);
            setModelPickerOpen(false);
          }}
          modelPickerOpen={modelPickerOpen}
          onToggleModelPicker={() => setModelPickerOpen((open) => !open)}
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
          researchDoc={researchDoc}
          extractingTasks={selectedExtractingTasks}
          onExtractTasks={() => void extractTasks(selectedMission.id)}
          chatMessages={selectedChatMessages}
          chatSending={selectedChatSending}
          agentTranscript={agentTranscript}
          reasoningByMessage={reasoningByMessage}
          onOpenDiffFile={(path) => {
            setFocusedDiffFile(path);
            setDiffModalOpen(true);
          }}
          onSendChat={(text) => void sendAgentChat(selectedMission.id, text)}
          verifyOpen={verifyOpen}
          onToggleVerifyOpen={() => setVerifyOpen((open) => !open)}
          verificationCommand={selectedVerificationCommand}
          onChangeVerificationCommand={(command) =>
            setVerificationCommandByMission((current) => ({ ...current, [selectedMission.id]: command }))
          }
          verificationOutputText={selectedVerificationOutput}
          onRunVerification={() => void runVerificationFor(selectedMission.id)}
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
