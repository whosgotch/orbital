// A live, two-way conversation with an agent. You steer the agent by sending
// messages; it keeps its session across turns and its diff evolves in place.
// The glanceable "what it's doing" status + raw reasoning sit just under the
// thread, so the chat stays the focus while the work stays inspectable.
import { useEffect, useRef, useState } from "react";
import { Loader, SendHorizontal } from "lucide-react";
import { AgentStatus } from "./AgentStatus";
import type { TranscriptEntry } from "./AgentTranscript";
import type { AgentStatusModel } from "../agentStatus";
import type { ChatMessage } from "../domain";

export function AgentChat({
  messages,
  statusModel,
  transcript,
  onSend,
  sending,
}: {
  messages: ChatMessage[];
  statusModel: AgentStatusModel;
  transcript: TranscriptEntry[];
  onSend: (text: string) => void;
  sending: boolean;
}) {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as the conversation and the agent's work grow.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages.length, sending, statusModel.now]);

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
            Tell this agent what to build. It keeps its context across messages, so you can refine
            with follow-ups instead of starting over.
          </div>
        ) : null}

        {messages.map((message) => (
          <div key={message.id} className={`chat-bubble ${message.role}`}>
            <span className="chat-text">{message.text}</span>
          </div>
        ))}

        {statusModel.hasActivity ? (
          <div className="chat-work">
            <AgentStatus model={statusModel} transcript={transcript} />
          </div>
        ) : null}
      </div>

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
    </div>
  );
}
