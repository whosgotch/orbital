// Renders an agent's stream of consciousness: its reasoning (thoughts) and the
// edits/commands it ran (actions), grouped under the agent that produced them.
// This is the read-only foundation for a future two-way chat with the agent.
import { Brain, Wrench, CircleDot } from "lucide-react";

export type TranscriptKind = "thought" | "action" | "status";

export type TranscriptEntry = {
  id: string;
  kind: TranscriptKind;
  text: string;
  agent: string;
};

function Glyph({ kind }: { kind: TranscriptKind }) {
  if (kind === "thought") return <Brain size={14} aria-hidden="true" />;
  if (kind === "action") return <Wrench size={13} aria-hidden="true" />;
  return <CircleDot size={12} aria-hidden="true" />;
}

export function AgentTranscript({ entries, emptyLabel }: { entries: TranscriptEntry[]; emptyLabel: string }) {
  if (entries.length === 0) {
    return <div className="transcript-empty">{emptyLabel}</div>;
  }

  return (
    <div className="transcript">
      {entries.map((entry, index) => {
        const showAgent = entry.agent && entry.agent !== entries[index - 1]?.agent;
        return (
          <div key={entry.id}>
            {showAgent ? <div className="transcript-agent">{entry.agent}</div> : null}
            <div className={`transcript-entry ${entry.kind}`}>
              <span className="transcript-glyph">
                <Glyph kind={entry.kind} />
              </span>
              <span className="transcript-text">{entry.text}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
