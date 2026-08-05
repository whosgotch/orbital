import { ArrowUp, FolderOpen, GitBranch, History, Plus, X } from "lucide-react";
import type { GitSync, Repository } from "../workspace/domain";

type TopBarProps = {
  repositories: Repository[];
  activeRepoPath: string;
  onSelectRepo: (path: string) => void;
  onCloseRepo: (repositoryId: string) => void;
  onChooseFolder: () => void;
  refreshing: boolean;
  draftRepositoryAvailable: boolean;
  onDraftTask: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  // undefined until the repo's position against its remote has been read.
  gitSync: GitSync | undefined;
  pushing: boolean;
  onPush: () => void;
};

// Pushing sends the whole branch, so it says so here rather than in a task's
// gate, where every control acts on that one mission's patch.
function pushState(sync: GitSync): { label: string; title: string; disabled: boolean } {
  const behind = sync.behind > 0 ? `, ${sync.behind} behind` : "";
  if (!sync.remote) {
    return { label: "", title: `${sync.branch} has no git remote — add one to push`, disabled: true };
  }
  if (!sync.upstream) {
    return { label: "Publish", title: `Publish ${sync.branch} to ${sync.remote}`, disabled: false };
  }
  if (sync.ahead === 0) {
    return { label: "", title: `Up to date with ${sync.upstream}${behind}`, disabled: true };
  }
  return {
    label: String(sync.ahead),
    title: `Push ${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} to ${sync.upstream}${behind}`,
    disabled: false,
  };
}

export function TopBar({
  repositories,
  activeRepoPath,
  onSelectRepo,
  onCloseRepo,
  onChooseFolder,
  refreshing,
  draftRepositoryAvailable,
  onDraftTask,
  historyOpen,
  onToggleHistory,
  gitSync,
  pushing,
  onPush,
}: TopBarProps) {
  const push = gitSync ? pushState(gitSync) : undefined;

  return (
    <header className="topbar">
      <div className="topbar-repos">
        {repositories.map((repo) => (
          <span key={repo.id} className={`repo-tab ${repo.path === activeRepoPath ? "active" : ""}`}>
            <button className="repo-tab-name" type="button" onClick={() => onSelectRepo(repo.path)} title={repo.path}>
              {repo.name}
            </button>
            <button
              className="repo-close"
              type="button"
              onClick={() => onCloseRepo(repo.id)}
              title="Close repository"
              aria-label={`Close ${repo.name}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <button
          className="ghost icon-button"
          type="button"
          onClick={onChooseFolder}
          disabled={refreshing}
          title="Open a repository"
          aria-label="Open a repository"
        >
          <FolderOpen size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="topbar-actions">
        {gitSync && push ? (
          <button
            className="ghost branch-push"
            type="button"
            onClick={onPush}
            disabled={push.disabled || pushing}
            title={push.title}
          >
            <GitBranch size={13} aria-hidden="true" />
            <span className="branch-push-name">{gitSync.branch}</span>
            {push.label ? (
              <span className="branch-push-count">
                <ArrowUp size={11} aria-hidden="true" />
                {pushing ? "…" : push.label}
              </span>
            ) : null}
          </button>
        ) : null}
        <button
          className="ghost icon-button"
          type="button"
          onClick={onDraftTask}
          disabled={!draftRepositoryAvailable}
          title={draftRepositoryAvailable ? "Draft a task card on the canvas" : "Open a repository first"}
          aria-label="Draft a task card"
        >
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          className={`ghost icon-button ${historyOpen ? "active" : ""}`}
          type="button"
          onClick={onToggleHistory}
          title="Git history"
          aria-label="Git history"
        >
          <History size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
