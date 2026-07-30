import { FolderOpen, History, Plus, X } from "lucide-react";
import type { Repository } from "../workspace/domain";

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
};

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
}: TopBarProps) {
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
