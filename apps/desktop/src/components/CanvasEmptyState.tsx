// The canvas's placeholder when there's nothing to draw yet: no repository
// open (offers the folder picker + recent list) or a repo with no tasks
// (points at the prompt bar).
import { FolderOpen } from "lucide-react";
import { recentRepoPaths, repoNameFromPath } from "../recentRepos";

type CanvasEmptyStateProps = {
  hasRepositories: boolean;
  refreshing: boolean;
  onChooseFolder: () => void;
  onOpenRepoAtPath: (path: string) => void;
};

export function CanvasEmptyState({ hasRepositories, refreshing, onChooseFolder, onOpenRepoAtPath }: CanvasEmptyStateProps) {
  const recent = hasRepositories ? [] : recentRepoPaths();

  return (
    <div className="canvas-hint">
      <div className="canvas-hint-card">
        <span className="canvas-hint-title">{hasRepositories ? "No tasks yet" : "No repository open"}</span>
        <p>
          {hasRepositories
            ? "Describe a task in the prompt bar below — an agent picks it up from there."
            : "Open a repository to put it on the canvas."}
        </p>
        {!hasRepositories ? (
          <>
            <button className="secondary" type="button" onClick={onChooseFolder} disabled={refreshing}>
              <FolderOpen size={14} aria-hidden="true" />
              <span>Open repository</span>
            </button>
            {recent.length > 0 ? (
              <ul className="canvas-hint-recent">
                {recent.map((path) => (
                  <li key={path}>
                    <button
                      className="recent-repo"
                      type="button"
                      onClick={() => onOpenRepoAtPath(path)}
                      disabled={refreshing}
                      title={path}
                    >
                      <FolderOpen size={14} aria-hidden="true" />
                      <span className="workspace-repo-name">{repoNameFromPath(path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
