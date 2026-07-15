// The right-docked inspector for the selected mission: prompt header, the
// chat/changes/doc tab switch, and (for changes) the verify bar and
// approve/reject actions. Props in, callbacks out — App owns all the state.
import { useState } from "react";
import { Check, ChevronDown, ListTree, Loader, Pencil, Terminal, Trash2, X } from "lucide-react";
import { AgentChat, ChangesCard } from "./AgentChat";
import { DocumentView } from "./DocumentView";
import { ReviseBox } from "./ReviseBox";
import type { TranscriptEntry } from "./AgentTranscript";
import type { AgentStatusModel } from "../agentStatus";
import { verifyPillClass, verifyPillLabel, verificationOutput } from "../missionUi";
import type { CommitInfo, WorkspaceRuntime } from "../workspaceAdapter";
import type { WorkspaceMission } from "../graph";
import type { ChatMessage, Repository } from "../domain";

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
  onClose: () => void;
  taskView: "chat" | "changes" | "doc";
  onChangeTaskView: (view: "chat" | "changes" | "doc") => void;
  agentStatus: AgentStatusModel;
  patchReady: boolean;
  commit: CommitInfo;
  researchDoc: string;
  extractingTasks: boolean;
  onExtractTasks: () => void;
  chatMessages: ChatMessage[];
  chatSending: boolean;
  agentTranscript: TranscriptEntry[];
  onOpenDiffFile: (path: string) => void;
  onSendChat: (text: string) => void;
  verifyOpen: boolean;
  onToggleVerifyOpen: () => void;
  verificationCommand: string;
  onChangeVerificationCommand: (command: string) => void;
  verificationOutputText: string;
  onRunVerification: () => void;
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
  onClose,
  taskView,
  onChangeTaskView,
  agentStatus,
  patchReady,
  commit,
  researchDoc,
  extractingTasks,
  onExtractTasks,
  chatMessages,
  chatSending,
  agentTranscript,
  onOpenDiffFile,
  onSendChat,
  verifyOpen,
  onToggleVerifyOpen,
  verificationCommand,
  onChangeVerificationCommand,
  verificationOutputText,
  onRunVerification,
  onReject,
  onApprove,
}: TaskPanelProps) {
  // Which mission's prompt is expanded past the two-line clamp — keyed by id
  // so switching nodes collapses it again without any effect.
  const [expandedPromptFor, setExpandedPromptFor] = useState("");
  const promptExpanded = expandedPromptFor === mission.id;
  return (
    <aside className="inspector task-window" aria-label="Task">
      <section className="task-panel" aria-label="Task">
        <div className="panel-head review-head">
          <div>
            <div className="section-label">
              {repository?.name ?? "workspace"} · {mission.kind === "tool" ? "tool" : mission.kind === "research" ? "research" : "task"}
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
          {mission.kind === "research" ? (
            <button
              type="button"
              role="tab"
              aria-selected={taskView === "doc"}
              className={`task-switch-btn ${taskView === "doc" ? "active" : ""}`}
              onClick={() => onChangeTaskView("doc")}
            >
              Document
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={taskView === "chat"}
            className={`task-switch-btn ${taskView === "chat" ? "active" : ""}`}
            onClick={() => onChangeTaskView("chat")}
          >
            Chat
          </button>
          {mission.kind !== "research" ? (
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
          ) : null}
          <div className="task-switch-spacer" />
        </div>

        <div className="task-body">
          {taskView === "doc" ? (
            <div className="plan-doc research-doc">
              {researchDoc ? (
                <>
                  <div className="research-doc-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={extractingTasks}
                      onClick={onExtractTasks}
                      title="Ask the AI to propose draft tasks from these findings"
                    >
                      {extractingTasks ? <Loader size={14} className="spin" aria-hidden="true" /> : <ListTree size={14} aria-hidden="true" />}
                      <span>{extractingTasks ? "Extracting…" : "Create tasks"}</span>
                    </button>
                  </div>
                  <DocumentView content={researchDoc} />
                </>
              ) : (
                <div className="diff-empty">
                  {runtime.status === "running"
                    ? "The researcher is reading the repo — findings land here."
                    : "No findings yet — run the research or ask it something in Chat."}
                </div>
              )}
            </div>
          ) : taskView === "chat" ? (
            <AgentChat
              messages={chatMessages}
              statusModel={agentStatus}
              transcript={agentTranscript}
              files={agentStatus.files}
              onOpenFile={onOpenDiffFile}
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

              <div className="verify-bar">
                <button type="button" className="verify-status-toggle" onClick={onToggleVerifyOpen} aria-expanded={verifyOpen}>
                  <span className={`verify-pill ${verifyPillClass(runtime)}`}>{verifyPillLabel(runtime)}</span>
                  <ChevronDown size={14} className={`verify-chevron ${verifyOpen ? "open" : ""}`} aria-hidden="true" />
                </button>
                <button
                  className="secondary mini"
                  type="button"
                  disabled={runtime.patchStatus !== "approved" || runtime.verified || !verificationCommand.trim()}
                  onClick={onRunVerification}
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
                    value={verificationCommand}
                    onChange={(event) => onChangeVerificationCommand(event.target.value)}
                  />
                  <pre className="test-output">{verificationOutput(runtime, verificationOutputText)}</pre>
                </div>
              ) : null}

              {commit.hash ? (
                <div className="landed-commit">
                  <code className="history-hash">{commit.hash}</code>
                  <span>{commit.subject}</span>
                </div>
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
          )}
        </div>
      </section>
    </aside>
  );
}
