import { useState } from "react";

export type TranscriptKind = "reasoning" | "thought" | "action" | "status";

export type TranscriptEntry = {
  id: string;
  kind: TranscriptKind;
  text: string;
  agent: string;
};

// Claude Code's terminal glyphs: ✻ the model's own thinking, ⏺ narration and
// tool calls, ⎿ a lifecycle line.
const GLYPH: Record<TranscriptKind, string> = {
  reasoning: "✻",
  thought: "✻",
  action: "⏺",
  status: "⎿",
};

function Glyph({ kind }: { kind: TranscriptKind }) {
  return <span className="glyph-char" aria-hidden="true">{GLYPH[kind]}</span>;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0];
  return line.length > 120 ? line.slice(0, 120) + "…" : line;
}

// Real chain of thought runs long and would bury the tool spine, so it stays
// folded to its opening line until asked for.
function ReasoningEntry({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const head = firstLine(text);
  const foldable = text.trim() !== head;

  return (
    <button
      type="button"
      className={`transcript-entry reasoning${expanded ? " expanded" : ""}`}
      onClick={() => setExpanded((current) => !current)}
      aria-expanded={expanded}
      disabled={!foldable}
    >
      <span className="transcript-glyph">
        <Glyph kind="reasoning" />
      </span>
      <span className="transcript-text">
        {expanded ? text : head}
        {!expanded && foldable ? <span className="transcript-more"> …</span> : null}
      </span>
    </button>
  );
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
            {entry.kind === "reasoning" ? (
              <ReasoningEntry text={entry.text} />
            ) : (
              <div className={`transcript-entry ${entry.kind}`}>
                <span className="transcript-glyph">
                  <Glyph kind={entry.kind} />
                </span>
                <span className="transcript-text">{entry.text}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
