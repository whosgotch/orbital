// A glanceable summary of what an agent is doing: a phase spine, the files it
// touched (with sizes — so scope is obvious at a glance), and a live "now" line.
// The raw reasoning transcript stays one click away behind "show reasoning".
import { useState } from "react";
import { Check, CircleDot, Loader, X, FilePlus, FileMinus, FilePen, ChevronRight, ChevronDown } from "lucide-react";
import { AgentTranscript, type TranscriptEntry } from "./AgentTranscript";
import type { AgentPhaseStatus, AgentStatusModel, FileChange } from "../agentStatus";

function PhaseGlyph({ status }: { status: AgentPhaseStatus }) {
  if (status === "done") return <Check size={12} aria-hidden="true" />;
  if (status === "failed") return <X size={12} aria-hidden="true" />;
  if (status === "active") return <CircleDot size={12} aria-hidden="true" />;
  return <span className="phase-dot" aria-hidden="true" />;
}

function ChangeGlyph({ change }: { change: FileChange }) {
  if (change === "added") return <FilePlus size={13} aria-hidden="true" />;
  if (change === "deleted") return <FileMinus size={13} aria-hidden="true" />;
  return <FilePen size={13} aria-hidden="true" />;
}

export function AgentStatus({ model, transcript }: { model: AgentStatusModel; transcript: TranscriptEntry[] }) {
  const [showReasoning, setShowReasoning] = useState(false);

  if (!model.hasActivity) {
    return (
      <div className="transcript-empty">
        No agent activity yet — run this mission with an AI worker to watch it work.
      </div>
    );
  }

  return (
    <div className="agent-status">
      <div className="agent-status-head">
        <span className="agent-status-name">{model.agentLabel}</span>
        <span className={`agent-status-live ${model.isLive ? "live" : ""}`}>
          {model.isLive ? <Loader size={12} className="spin" aria-hidden="true" /> : null}
          {model.liveLabel}
        </span>
      </div>

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

      {model.files.length > 0 ? (
        <div className="touched">
          <div className="touched-head">
            Touching {model.files.length} file{model.files.length === 1 ? "" : "s"}
          </div>
          <ul className="touched-list">
            {model.files.map((file) => (
              <li key={file.path} className={`touched-file ${file.change}`}>
                <span className="touched-glyph">
                  <ChangeGlyph change={file.change} />
                </span>
                <span className="touched-path">{file.path}</span>
                <span className="touched-counts">
                  {file.added > 0 ? <span className="add">+{file.added}</span> : null}
                  {file.removed > 0 ? <span className="del">−{file.removed}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {model.now ? <div className="agent-now">{model.now}</div> : null}

      <div className="agent-status-foot">
        <span className="agent-meta">
          {model.steps > 0 ? `${model.steps} step${model.steps === 1 ? "" : "s"}` : ""}
          {model.steps > 0 && model.elapsed ? " · " : ""}
          {model.elapsed}
        </span>
        {transcript.length > 0 ? (
          <button type="button" className="ghost mini-text" onClick={() => setShowReasoning((shown) => !shown)}>
            {showReasoning ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {showReasoning ? "hide reasoning" : "show reasoning"}
          </button>
        ) : null}
      </div>

      {showReasoning ? (
        <div className="agent-reasoning">
          <AgentTranscript entries={transcript} emptyLabel="No reasoning captured." />
        </div>
      ) : null}
    </div>
  );
}
