import { useState } from "react";
import { Loader, ChevronRight, ChevronDown } from "lucide-react";
import { AgentTranscript, type TranscriptEntry } from "./AgentTranscript";
import type { AgentPhaseStatus, AgentStatusModel } from "./statusModel";

// Claude Code's state glyphs: ✓ done, ✗ failed, ⏺ active, · not reached.
function PhaseGlyph({ status }: { status: AgentPhaseStatus }) {
  if (status === "done") return <span className="glyph-char" aria-hidden="true">✓</span>;
  if (status === "failed") return <span className="glyph-char" aria-hidden="true">✗</span>;
  if (status === "active") return <span className="glyph-char" aria-hidden="true">⏺</span>;
  return <span className="phase-dot" aria-hidden="true" />;
}

export function AgentStatus({
  model,
  transcript,
  alwaysVisible = false,
}: {
  model: AgentStatusModel;
  transcript: TranscriptEntry[];
  // Tool missions have no chat messages to pin reasoning to, so their status
  // (and whole-run "show reasoning") must stay visible after the run ends too.
  alwaysVisible?: boolean;
}) {
  const [showReasoning, setShowReasoning] = useState(false);

  if (!model.hasActivity) {
    return (
      <div className="transcript-empty">
        No agent activity yet — run this mission with an AI worker to watch it work.
      </div>
    );
  }

  // A finished turn's reasoning lives in its message footer now; once it's no
  // longer live, this block has nothing left to say — except for read-only
  // tool missions, whose run log has no message to pin to.
  if (!model.isLive && !alwaysVisible) {
    return null;
  }

  // A finished, fully green spine says nothing the ✓ in the header doesn't;
  // it earns its space only while live or when a phase failed.
  const spineInformative = model.isLive || model.phases.some((phase) => phase.status === "failed");

  return (
    <div className="agent-status">
      <div className="agent-status-head">
        <span className={`agent-status-live ${model.isLive ? "live" : ""}`} aria-label={model.liveLabel}>
          {model.isLive ? <Loader size={12} className="spin" aria-hidden="true" /> : <span className="glyph-char" aria-hidden="true">✓</span>}
        </span>
        <span className="agent-status-name">{model.agentLabel}</span>
        <span className="agent-meta">
          {model.steps > 0 ? ` · ${model.steps} step${model.steps === 1 ? "" : "s"}` : ""}
          {model.elapsed ? ` · ${model.elapsed}` : ""}
        </span>
        <span className="agent-status-spacer" />
        {transcript.length > 0 ? (
          <button type="button" className="ghost mini-text" onClick={() => setShowReasoning((shown) => !shown)}>
            {showReasoning ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {showReasoning ? "hide reasoning" : "show reasoning"}
          </button>
        ) : null}
      </div>

      {spineInformative ? (
        <ol className="phase-spine">
          {model.phases.map((phase) => (
            <li key={phase.id} className={`phase ${phase.status}`}>
              <span className="phase-glyph">
                <PhaseGlyph status={phase.status} />
              </span>
              <span className="phase-label">{phase.label}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {model.now ? <div className="agent-now">{model.now}</div> : null}

      {showReasoning ? (
        <div className="agent-reasoning">
          <AgentTranscript entries={transcript} emptyLabel="No reasoning captured." />
        </div>
      ) : null}
    </div>
  );
}
