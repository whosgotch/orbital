import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Copy, GitBranch, Pencil, RotateCcw, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { AgentChat, ChangesCard } from "../chat/AgentChat";
import { UsageDetails } from "../chat/UsageDetails";
import { ReviseBox } from "../chat/ReviseBox";
import type { TranscriptEntry } from "../chat/AgentTranscript";
import type { AgentStatusModel } from "../chat/statusModel";
import type { CommitInfo, WorkspaceRuntime } from "../workspace/workspaceAdapter";
import type { WorkspaceMission } from "../canvas/graph";
import type { ChatMessage, Repository } from "../workspace/domain";

const PANEL_WIDTH_KEY = "orbital.taskPanelWidth";
const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_DEFAULT = 440;

function clampPanelWidth(width: number): number {
  const max = Math.min(720, window.innerWidth * 0.6);
  return Math.min(Math.max(width, PANEL_WIDTH_MIN), max);
}

// App owns the width (it also positions the prompt bar around the panel via
// the --task-panel-width CSS var); this reads the persisted value once.
export function loadPanelWidth(): number {
  const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  return clampPanelWidth(stored > 0 ? stored : PANEL_WIDTH_DEFAULT);
}

type TaskPanelProps = {
  mission: WorkspaceMission;
  repository: Repository | undefined;
  missionStatus: { label: string; className: string };
  runtime: WorkspaceRuntime;
  editingPrompt: boolean;
  onBeginEditPrompt: () => void;
  onCancelEditPrompt: () => void;
  promptDraft: string;
  onChangePromptDraft: (text: string) => void;
  onSavePrompt: () => void;
  onDelete: () => void;
  onRun: () => void;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  taskView: "chat" | "changes";
  onChangeTaskView: (view: "chat" | "changes") => void;
  agentStatus: AgentStatusModel;
  patchReady: boolean;
  commit: CommitInfo;
  chatMessages: ChatMessage[];
  chatSending: boolean;
  agentTranscript: TranscriptEntry[];
  reasoningByMessage: Record<string, TranscriptEntry[]>;
  onOpenDiffFile: (path: string) => void;
  onSendChat: (text: string) => void;
  onReject: () => void;
  onApprove: () => void;
};

export function TaskPanel({
  mission,
  repository,
  missionStatus,
  runtime,
  editingPrompt,
  onBeginEditPrompt,
  onCancelEditPrompt,
  promptDraft,
  onChangePromptDraft,
  onSavePrompt,
  onDelete,
  onRun,
  onClose,
  onWidthChange,
  taskView,
  onChangeTaskView,
  agentStatus,
  patchReady,
  commit,
  chatMessages,
  chatSending,
  agentTranscript,
  reasoningByMessage,
  onOpenDiffFile,
  onSendChat,
  onReject,
  onApprove,
}: TaskPanelProps) {
  // Which mission's prompt is expanded past the two-line clamp — keyed by id
  // so switching nodes collapses it again without any effect.
  const [expandedPromptFor, setExpandedPromptFor] = useState("");
  const promptExpanded = expandedPromptFor === mission.id;

  const onResizeHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      onWidthChange(clampPanelWidth(window.innerWidth - moveEvent.clientX));
    };
    const onUp = (upEvent: PointerEvent) => {
      localStorage.setItem(PANEL_WIDTH_KEY, String(clampPanelWidth(window.innerWidth - upEvent.clientX)));
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <aside className="inspector task-window" aria-label="Task">
      <div
        className="task-panel-resize-handle"
        onPointerDown={onResizeHandlePointerDown}
        title="Drag to resize"
        role="separator"
        aria-orientation="vertical"
      />
      <section className="task-panel" aria-label="Task">
        <div className="panel-head review-head">
          <div>
            <div className="section-label">
              {repository?.name ?? "workspace"} · {mission.kind === "tool" ? "tool" : "task"}
              {repository?.branch ? ` · ${repository.branch}` : ""}
            </div>
            <h2
              className="work-order-title"
              onClick={() => setExpandedPromptFor(promptExpanded ? "" : mission.id)}
              title={promptExpanded ? "Collapse prompt" : "Show full prompt"}
            >
              {mission.title}
            </h2>
          </div>
          <div className="task-head-actions">
            <div className={`mini-state ${missionStatus.className}`}>{missionStatus.label}</div>
            <button
              className={`node-action secondary icon-button ${editingPrompt ? "active" : ""}`}
              type="button"
              onClick={editingPrompt ? onCancelEditPrompt : onBeginEditPrompt}
              disabled={runtime.status === "running"}
              title="Edit this task's prompt"
              aria-label="Edit prompt"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              className="node-action secondary danger icon-button"
              type="button"
              onClick={onDelete}
              title="Remove this task"
              aria-label="Remove task"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
            <button
              className="node-action secondary icon-button"
              type="button"
              onClick={onClose}
              title="Close panel (Esc)"
              aria-label="Close panel"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>

        {runtime.blockedReason ? (
          <div className="task-error" role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            <div className="task-error-body">
              <span className="task-error-title">Blocked</span>
              <pre className="task-error-text">{runtime.blockedReason}</pre>
            </div>
            <div className="task-error-actions">
              <button
                type="button"
                className="ghost mini-text"
                onClick={() => navigator.clipboard?.writeText(runtime.blockedReason ?? "")}
                title="Copy the error"
                aria-label="Copy the error"
              >
                <Copy size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="node-action secondary"
                onClick={onRun}
                title="Start a fresh run of this task"
              >
                <RotateCcw size={12} aria-hidden="true" />
                Run again
              </button>
            </div>
          </div>
        ) : null}

        {promptExpanded && !editingPrompt ? (
          <div className="prompt-full" onClick={() => setExpandedPromptFor("")} title="Collapse prompt">
            {mission.prompt}
          </div>
        ) : null}

        {editingPrompt ? (
          <div className="node-prompt-editor">
            <textarea
              className="node-prompt-input"
              aria-label="Task prompt"
              value={promptDraft}
              onChange={(event) => onChangePromptDraft(event.target.value)}
              rows={4}
              autoFocus
            />
            <div className="node-prompt-actions">
              <button className="node-action secondary" type="button" onClick={onCancelEditPrompt}>
                Cancel
              </button>
              <button className="node-action primary" type="button" disabled={!promptDraft.trim()} onClick={onSavePrompt}>
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
            onClick={() => onChangeTaskView("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={taskView === "changes"}
            className={`task-switch-btn ${taskView === "changes" ? "active" : ""}`}
            onClick={() => onChangeTaskView("changes")}
          >
            Changes
            {agentStatus.files.length > 0 ? <span className="tab-count">{agentStatus.files.length}</span> : null}
            {patchReady && taskView !== "changes" ? <span className="task-switch-dot" aria-hidden="true" /> : null}
          </button>
          <div className="task-switch-spacer" />
        </div>

        <UsageDetails usage={agentStatus.usage} />

        <div className="task-body">
          {taskView === "chat" ? (
            <AgentChat
              messages={chatMessages}
              statusModel={agentStatus}
              transcript={agentTranscript}
              reasoningByMessage={reasoningByMessage}
              onGoToChanges={() => onChangeTaskView("changes")}
              sending={chatSending}
              onSend={onSendChat}
              readOnly={mission.kind === "tool"}
              repoPath={repository?.path}
            />
          ) : (
            <div className="task-changes">
              {agentStatus.files.length > 0 ? (
                <ChangesCard files={agentStatus.files} onOpenFile={onOpenDiffFile} />
              ) : (
                <div className="diff-empty">
                  {patchReady ? "No patch proposal captured for this task." : "No changes yet — chat with the agent to make some."}
                </div>
              )}

              {agentStatus.files.length > 0 && mission.kind !== "tool" ? (
                <ReviseBox sending={chatSending} onSend={onSendChat} />
              ) : null}

              {commit.hash ? (
                <div className="landed-commit">
                  <div className="landed-commit-ref">
                    {commit.branch ? (
                      <span className="git-branch-chip">
                        <GitBranch size={12} aria-hidden="true" />
                        {commit.branch}
                      </span>
                    ) : null}
                    <code className="history-hash">{commit.hash}</code>
                  </div>
                  <span className="landed-commit-subject" title={commit.subject}>
                    {commit.subject}
                  </span>
                </div>
              ) : null}

              <div className="task-gate">
                {/* Approve + apply is the last step, so the gate says plainly where the
                    code is right now: still in the agent's own worktree. */}
                {patchReady && runtime.patchStatus === "pending" ? (
                  <p className="gate-note">
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span>
                      Nothing is in {repository?.name ?? "your repo"} yet — these changes live in the agent's worktree until you
                      apply them.
                    </span>
                  </p>
                ) : null}

                <div className="actions">
                  <button
                    className="secondary"
                    type="button"
                    disabled={!patchReady || runtime.patchStatus !== "pending"}
                    onClick={onReject}
                  >
                    <X size={16} aria-hidden="true" />
                    <span>Reject</span>
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={!patchReady || runtime.patchStatus !== "pending"}
                    onClick={onApprove}
                  >
                    <Check size={16} aria-hidden="true" />
                    <span>Approve + apply</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </aside>
  );
}
