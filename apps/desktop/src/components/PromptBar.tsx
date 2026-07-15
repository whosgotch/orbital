// The universal intake: a chat-style prompt bar floating at the bottom of the
// canvas. Enter creates a task instantly (one per line — a whole backlog at
// once); Research asks a read-only question, whose findings a research node
// can later turn into draft tasks. Enter and the primary button route by
// detected intent (question → Research, otherwise Create); the secondary
// button always offers the other one. Pasted screenshots ride along as
// attachments.
import { useRef, useState } from "react";
import { CornerDownLeft, CornerDownRight, Search, X } from "lucide-react";
import { AttachmentChips } from "./AttachmentChips";
import { usePastedImages } from "../attachments";
import { detectIntent } from "../intent";

type PromptBarProps = {
  // The repository new work lands in; undefined disables the bar.
  repoName?: string;
  repoPath?: string;
  // The selected mission node Create/Research will chain the new mission
  // after, if any — cleared by the × on the chip or by selecting elsewhere.
  followUp?: { id: string; title: string };
  onDismissFollowUp: () => void;
  onCreate: (text: string, attachments: string[]) => void;
  onResearch: (text: string, attachments: string[]) => void;
};

export function PromptBar({
  repoName,
  repoPath,
  followUp,
  onDismissFollowUp,
  onCreate,
  onResearch,
}: PromptBarProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachments = usePastedImages(repoPath);
  const trimmed = text.trim();
  const ready = Boolean(trimmed) && Boolean(repoName);
  const intent = detectIntent(trimmed);

  const submit = (action: (value: string, attachments: string[]) => void) => {
    if (!ready) return;
    action(trimmed, attachments.paths);
    setText("");
    attachments.clear();
    inputRef.current?.focus();
  };

  return (
    <div className="prompt-bar" aria-label="New work">
      {followUp ? (
        <div className="attachment-chips">
          <span className="attachment-chip follow-up-chip">
            <CornerDownRight size={12} aria-hidden="true" />
            <span className="attachment-chip-name">follow-up of: {followUp.title}</span>
            <button type="button" onClick={onDismissFollowUp} aria-label="Remove follow-up link">
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        </div>
      ) : null}
      <AttachmentChips paths={attachments.paths} onRemove={attachments.remove} />
      <textarea
        ref={inputRef}
        className="prompt-bar-input"
        aria-label="Describe a task"
        placeholder={repoName ? "Describe a task — question triggers Research, Enter creates" : "Open a repository to start"}
        value={text}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        disabled={!repoName}
        onChange={(event) => setText(event.target.value)}
        onPaste={attachments.onPaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit(intent === "research" ? onResearch : onCreate);
          }
        }}
      />
      <div className="prompt-bar-actions">
        {repoName ? <span className="prompt-bar-target">{repoName}</span> : null}
        {intent === "research" ? (
          <button
            type="button"
            className="secondary"
            disabled={!ready}
            onClick={() => submit(onCreate)}
            title="Create task — one per line"
          >
            <CornerDownLeft size={13} aria-hidden="true" />
            <span>Create</span>
          </button>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={!ready}
            onClick={() => submit(onResearch)}
            title="Ask about the repo — a read-only researcher answers with a findings document"
          >
            <Search size={13} aria-hidden="true" />
            <span>Research</span>
          </button>
        )}
        {intent === "research" ? (
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => submit(onResearch)}
            title="Ask about the repo — a read-only researcher answers with a findings document"
          >
            <Search size={13} aria-hidden="true" />
            <span>Research</span>
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => submit(onCreate)}
            title="Create task — one per line"
          >
            <CornerDownLeft size={13} aria-hidden="true" />
            <span>Create</span>
          </button>
        )}
      </div>
    </div>
  );
}
