// The app's header: brand mark, open-repository tabs, and the panel
// controls that live in the top-right corner. Purely presentational — every
// action is a callback prop, every open/closed flag comes in from App state.
import { FolderOpen, History, Plus, Rocket, X } from "lucide-react";
import logo from "../assets/orbital.png";
import type { Repository } from "../domain";

type TopBarProps = {
  repositories: Repository[];
  activeRepoPath: string;
  onSelectRepo: (path: string) => void;
  onCloseRepo: (repositoryId: string) => void;
  onChooseFolder: () => void;
  refreshing: boolean;
  draftRepositoryAvailable: boolean;
  onDraftTask: () => void;
  openPanel: null | "mission" | "history";
  onTogglePanel: (panel: "mission" | "history") => void;
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
  openPanel,
  onTogglePanel,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <img src={logo} className="brand-logo" alt="" width={16} height={16} />
        <span>Orbital</span>
      </div>

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
          className={`ghost icon-button ${openPanel === "mission" ? "active" : ""}`}
          type="button"
          onClick={() => onTogglePanel("mission")}
          title="Queue a backlog or multi-repo campaign"
          aria-label="Queue a backlog or campaign"
        >
          <Rocket size={14} aria-hidden="true" />
        </button>
        <button
          className={`ghost icon-button ${openPanel === "history" ? "active" : ""}`}
          type="button"
          onClick={() => onTogglePanel("history")}
          title="Git history"
          aria-label="Git history"
        >
          <History size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
