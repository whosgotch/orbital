// A live, two-way conversation with an agent. You steer the agent by sending
// messages; it keeps its session across turns and its diff evolves in place.
// Agent replies render as markdown, and the change set rides along as a
// clickable card — pick a file to open its diff.
import { useEffect, useRef, useState } from "react";
import { FileMinus, FilePen, FilePlus, Loader, SendHorizontal } from "lucide-react";
import { AgentStatus } from "./AgentStatus";
import { Markdown } from "./Markdown";
import type { TranscriptEntry } from "./AgentTranscript";
import type { AgentStatusModel, FileChange, TouchedFile } from "../agentStatus";
import type { ChatMessage } from "../domain";

function ChangeGlyph({ change }: { change: FileChange }) {
  if (change === "added") return <FilePlus size={13} aria-hidden="true" />;
  if (change === "deleted") return <FileMinus size={13} aria-hidden="true" />;
  return <FilePen size={13} aria-hidden="true" />;
}

// The glanceable change set: what changed, one click from the file's diff.
// Shared by chat (rides along with replies) and the Changes tab.
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
  files,
  onOpenFile,
  onSend,
  sending,
  readOnly = false,
}: {
  messages: ChatMessage[];
  statusModel: AgentStatusModel;
  transcript: TranscriptEntry[];
  files: TouchedFile[];
  onOpenFile: (path: string) => void;
  onSend: (text: string) => void;
  sending: boolean;
  // A tool step is a deterministic command, not a conversation — its panel
  // shows the run log but offers no composer to chat with.
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // Follow the newest turn as the conversation and the agent's work grow —
  // but only when already reading the tail, so scrolling up to study earlier
  // work isn't yanked back down by every streamed entry.
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    if (nearBottom) log.scrollTo({ top: log.scrollHeight });
  }, [messages.length, sending, statusModel.now, files.length, transcript.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    onSend(text);
    setDraft("");
  };

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

        {messages.map((message) => (
          <div key={message.id} className={`chat-bubble ${message.role}`}>
            {message.role === "assistant" ? (
              <Markdown text={message.text} />
            ) : (
              <span className="chat-text">{message.text}</span>
            )}
          </div>
        ))}

        {statusModel.hasActivity ? (
          <div className="chat-work">
            <AgentStatus model={statusModel} transcript={transcript} />
          </div>
        ) : null}

        {!sending && files.length > 0 ? <ChangesCard files={files} onOpenFile={onOpenFile} /> : null}
      </div>

      {readOnly ? null : (
      <div className="chat-composer">
        <textarea
          className="chat-input"
          aria-label="Message the agent"
          placeholder={sending ? "Agent is working…" : "Message the agent — ⏎ to send, ⇧⏎ for a new line"}
          value={draft}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
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
          {sending ? <Loader size={16} className="spin" aria-hidden="true" /> : <SendHorizontal size={16} aria-hidden="true" />}
        </button>
      </div>
      )}
    </div>
  );
}
