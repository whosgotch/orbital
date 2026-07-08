// The workspace's git history: every landed mission (and any outside commit)
// as a scannable list. Picking a commit opens its diff in the wide viewer, so
// "what actually landed" is always one click away.
import { GitCommitHorizontal, Loader } from "lucide-react";
import type { RepoCommit } from "../domain";

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export function HistoryPanel({
  commits,
  loading,
  onSelect,
}: {
  commits: RepoCommit[];
  loading: boolean;
  onSelect: (commit: RepoCommit) => void;
}) {
  if (loading) {
    return (
      <div className="history-empty">
        <Loader size={14} className="spin" aria-hidden="true" />
        Loading history…
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="history-empty">
        No commits yet — approve a mission's patch and it lands here as a commit.
      </div>
    );
  }

  return (
    <ul className="history-list">
      {commits.map((commit) => (
        <li key={commit.hash}>
          <button type="button" className="history-commit" onClick={() => onSelect(commit)}>
            <GitCommitHorizontal size={14} className="history-glyph" aria-hidden="true" />
            <span className="history-subject" title={commit.subject}>{commit.subject}</span>
            <span className="history-meta">
              <code className="history-hash">{commit.short_hash}</code>
              {relativeTime(commit.date)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
