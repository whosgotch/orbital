// Sends one more chat turn to the same session, so the diff revises in place instead of being redone from scratch.
import { useState } from "react";
import { Loader, SendHorizontal } from "lucide-react";

export function ReviseBox({
  onSend,
  sending,
  placeholder = "Not right? Tell it what to change…",
}: {
  onSend: (text: string) => void;
  sending: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="revise-box">
      <input
        className="revise-input"
        aria-label="Tell the agent what to change"
        placeholder={sending ? "Agent is working…" : placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        className="revise-send primary"
        type="button"
        onClick={submit}
        disabled={!text.trim() || sending}
        aria-label="Send change request"
        title="Send change request"
      >
        {sending ? <Loader size={14} className="spin" aria-hidden="true" /> : <SendHorizontal size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}
