import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus, Loader } from "lucide-react";
import { AgentStatus } from "./AgentStatus";
import { AgentTranscript } from "./AgentTranscript";
import { AttachmentChips } from "../intake/AttachmentChips";
import { attachmentLines, type PastedImages } from "../intake/attachments";
import { Markdown } from "../ui/Markdown";
import type { TranscriptEntry } from "./AgentTranscript";
import type { AgentStatusModel, FileChange, TouchedFile } from "./statusModel";
import type { ChatMessage } from "../workspace/domain";

function ChangeGlyph({ change }: { change: FileChange }) {
  if (change === "added") return <FilePlus size={13} aria-hidden="true" />;
  if (change === "deleted") return <FileMinus size={13} aria-hidden="true" />;
  return <FilePen size={13} aria-hidden="true" />;
}

function changesSummary(files: TouchedFile[]): string {
  const additions = files.reduce((sum, file) => sum + file.added, 0);
  const deletions = files.reduce((sum, file) => sum + file.removed, 0);
  const counts = [additions > 0 ? `+${additions}` : "", deletions > 0 ? `−${deletions}` : ""].filter(Boolean).join(" ");
  return `${files.length} file${files.length === 1 ? "" : "s"} changed${counts ? ` ${counts}` : ""}`;
}

export function ChangesCard({ files, onOpenFile }: { files: TouchedFile[]; onOpenFile: (path: string) => void }) {
  const additions = files.reduce((sum, file) => sum + file.added, 0);
  const deletions = files.reduce((sum, file) => sum + file.removed, 0);

  return (
    <div className="chat-changes">
      <div className="chat-changes-head">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <span className="chat-changes-stat">
          {additions > 0 ? <span className="add">+{additions}</span> : null}
          {deletions > 0 ? <span className="del">−{deletions}</span> : null}
        </span>
      </div>
      <ul className="chat-changes-list">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={`chat-changes-file ${file.change}`}
              onClick={() => onOpenFile(file.path)}
              title={`Open ${file.path} diff`}
            >
              <span className="chat-changes-glyph">
                <ChangeGlyph change={file.change} />
              </span>
              <span className="chat-changes-path">{file.path}</span>
              <span className="chat-changes-counts">
                {file.added > 0 ? <span className="add">+{file.added}</span> : null}
                {file.removed > 0 ? <span className="del">−{file.removed}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentChat({
  messages,
  statusModel,
  transcript,
  reasoningByMessage,
  onGoToChanges,
  onSend,
  sending,
  readOnly = false,
  draft,
  onChangeDraft,
  attachments,
}: {
  messages: ChatMessage[];
  statusModel: AgentStatusModel;
  // Used only by the live/read-only status block below the thread, for the turn that hasn't landed as a message yet.
  transcript: TranscriptEntry[];
  reasoningByMessage: Record<string, TranscriptEntry[]>;
  // Files changed ride along under the last reply as one link; clicking it
  // switches to the Changes tab instead of opening a diff modal from chat.
  onGoToChanges: (path?: string) => void;
  onSend: (text: string) => void;
  sending: boolean;
  // A tool step is a deterministic command, not a conversation — its panel
  // shows the run log but offers no composer to chat with.
  readOnly?: boolean;
  // The composer is owned by the panel, not by this view: switching to Changes
  // unmounts the chat, and a half-typed message must survive the round trip.
  draft: string;
  onChangeDraft: (text: string) => void;
  attachments: PastedImages;
}) {
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const logRef = useRef<HTMLDivElement>(null);

  // Follow the newest turn as the conversation and the agent's work grow —
  // but only when already reading the tail, so scrolling up to study earlier
  // work isn't yanked back down by every streamed entry.
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    if (nearBottom) log.scrollTo({ top: log.scrollHeight });
  }, [messages.length, sending, statusModel.now, statusModel.files.length, transcript.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    onSend(text + attachmentLines(attachments.paths));
    onChangeDraft("");
    attachments.clear();
  };

  const lastAssistantId = messages.reduce<string | undefined>(
    (id, message) => (message.role === "assistant" ? message.id : id),
    undefined,
  );
  // The status block below the thread carries the live/in-flight turn; once a
  // turn's done, it has nothing left to say except for read-only tool
  // missions, which have no chat message to pin their run log to.
  const showStatusBlock = statusModel.hasActivity && (statusModel.isLive || readOnly);

  return (
    <div className="agent-chat">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !statusModel.hasActivity ? (
          <div className="chat-empty">
            {readOnly
              ? "This tool step runs its command when its turn comes; the run log shows up here."
              : "Tell this agent what to build. It keeps its context across messages, so you can refine with follow-ups instead of starting over."}
          </div>
        ) : null}

        {messages.map((message) => {
          const reasoning = reasoningByMessage[message.id] ?? [];
          const hasReasoning = message.role === "assistant" && reasoning.length > 0;
          const showChanges = message.role === "assistant" && message.id === lastAssistantId && statusModel.files.length > 0;
          const expanded = expandedReasoning[message.id] ?? false;

          return (
            <div key={message.id} className={`chat-msg-group ${message.role}`}>
              <div className={`chat-bubble ${message.role}`}>
                {message.role === "assistant" ? (
                  <Markdown text={message.text} />
                ) : (
                  <span className="chat-text">{message.text}</span>
                )}
              </div>

              {hasReasoning || showChanges ? (
                <div className="chat-msg-footer">
                  {hasReasoning ? (
                    <button
                      type="button"
                      className="ghost mini-text"
                      onClick={() => setExpandedReasoning((current) => ({ ...current, [message.id]: !expanded }))}
                    >
                      {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                      reasoning
                    </button>
                  ) : null}
                  {showChanges ? (
                    <button type="button" className="chat-changes-line" onClick={() => onGoToChanges()}>
                      {changesSummary(statusModel.files)}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {hasReasoning && expanded ? (
                <div className="agent-reasoning">
                  <AgentTranscript entries={reasoning} emptyLabel="No reasoning captured." />
                </div>
              ) : null}
            </div>
          );
        })}

        {showStatusBlock ? (
          <div className="chat-activity">
            <AgentStatus model={statusModel} transcript={transcript} alwaysVisible={readOnly} />
          </div>
        ) : null}
      </div>

      {readOnly ? null : (
      <>
      <AttachmentChips paths={attachments.paths} onRemove={attachments.remove} />
      <div className="chat-composer">
        <textarea
          className="chat-input"
          aria-label="Message the agent"
          placeholder={sending ? "Agent is working…" : "Message the agent — ⏎ to send, ⇧⏎ for a new line"}
          value={draft}
          rows={2}
          onChange={(event) => onChangeDraft(event.target.value)}
          onPaste={attachments.onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="chat-send primary"
          type="button"
          onClick={submit}
          disabled={!draft.trim() || sending}
          aria-label="Send message"
          title="Send message"
        >
          {sending ? <Loader size={16} className="spin" aria-hidden="true" /> : <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />}
        </button>
      </div>
      </>
      )}
    </div>
  );
}
