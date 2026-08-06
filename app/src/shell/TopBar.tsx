import { useState } from "react";
import { ArrowUp, Check, ChevronDown, FolderOpen, GitBranch, History, Loader, Plus, X } from "lucide-react";
import type { GitSync, Repository } from "../workspace/domain";

type TopBarProps = {
  repositories: Repository[];
  activeRepoPath: string;
  onSelectRepo: (path: string) => void;
  onCloseRepo: (repositoryId: string) => void;
  onChooseFolder: () => void;
  refreshing: boolean;
  historyOpen: boolean;
  onToggleHistory: () => void;
  // undefined until the repo's position against its remote has been read.
  gitSync: GitSync | undefined;
  pushing: boolean;
  // True for a moment after a push succeeds, so the button can say it did.
  justPushed: boolean;
  onPush: () => void;
  branches: string[];
  branchMenuOpen: boolean;
  switching: boolean;
  onToggleBranchMenu: () => void;
  onSwitchBranch: (branch: string, create: boolean) => void;
};

// Pushing sends the whole branch, so it says so here rather than in a task's
// gate, where every control acts on that one mission's patch.
function pushState(sync: GitSync): { label: string; title: string; disabled: boolean; synced: boolean } {
  const behind = sync.behind > 0 ? `, ${sync.behind} behind` : "";
  if (!sync.remote) {
    return { label: "", title: `${sync.branch} has no git remote — add one to push`, disabled: true, synced: false };
  }
  if (!sync.upstream) {
    return { label: "Publish", title: `Publish ${sync.branch} to ${sync.remote}`, disabled: false, synced: false };
  }
  if (sync.ahead === 0) {
    return { label: "", title: `Up to date with ${sync.upstream}${behind}`, disabled: true, synced: true };
  }
  return {
    label: String(sync.ahead),
    title: `Push ${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} to ${sync.upstream}${behind}`,
    disabled: false,
    synced: false,
  };
}

export function TopBar({
  repositories,
  activeRepoPath,
  onSelectRepo,
  onCloseRepo,
  onChooseFolder,
  refreshing,
  historyOpen,
  onToggleHistory,
  gitSync,
  pushing,
  justPushed,
  onPush,
  branches,
  branchMenuOpen,
  switching,
  onToggleBranchMenu,
  onSwitchBranch,
}: TopBarProps) {
  const push = gitSync ? pushState(gitSync) : undefined;
  // Naming a new branch is the rare case, so it stays folded into one row until
  // asked for, instead of a field sitting over the list you usually want.
  const [naming, setNaming] = useState(false);
  const [newBranch, setNewBranch] = useState("");

  // Render-phase reset: a half-typed name never survives the popover closing.
  const [namingWhileOpen, setNamingWhileOpen] = useState(branchMenuOpen);
  if (namingWhileOpen !== branchMenuOpen) {
    setNamingWhileOpen(branchMenuOpen);
    setNaming(false);
    setNewBranch("");
  }

  const createBranch = () => {
    const name = newBranch.trim();
    if (name) onSwitchBranch(name, true);
  };

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
        {/* One control, two jobs: the name switches the branch, the count sends
            it. They stay joined because they answer the same question — which
            branch am I on, and where does its work stand. */}
        {gitSync && push ? (
          <div className="branch-control">
            <button
              className={`ghost branch-pick ${branchMenuOpen ? "active" : ""}`}
              type="button"
              onClick={onToggleBranchMenu}
              disabled={switching}
              title={`On ${gitSync.branch} — switch or create a branch`}
              aria-haspopup="listbox"
              aria-expanded={branchMenuOpen}
            >
              {switching ? (
                <Loader size={13} className="spin" aria-hidden="true" />
              ) : (
                <GitBranch size={13} aria-hidden="true" />
              )}
              <span className="branch-push-name">{gitSync.branch}</span>
              <ChevronDown size={11} aria-hidden="true" />
            </button>
            <button
              className="ghost branch-push"
              type="button"
              onClick={onPush}
              disabled={push.disabled || pushing || switching}
              title={justPushed ? `Pushed to ${gitSync.upstream}` : push.title}
            >
              {/* Every state says something: in flight, just landed, this many to
                  send, or nothing left to send. A blank button would leave the
                  one question this control exists to answer unanswered. */}
              {pushing ? (
                <span className="branch-push-count">
                  <Loader size={11} className="spin" aria-hidden="true" />
                </span>
              ) : justPushed ? (
                <span className="branch-push-count done">
                  <Check size={11} aria-hidden="true" />
                  pushed
                </span>
              ) : push.label ? (
                <span className="branch-push-count">
                  <ArrowUp size={11} aria-hidden="true" />
                  {push.label}
                </span>
              ) : push.synced ? (
                <span className="branch-push-count quiet">
                  <Check size={11} aria-hidden="true" />
                </span>
              ) : (
                <span className="branch-push-count quiet">
                  <ArrowUp size={11} aria-hidden="true" />
                </span>
              )}
            </button>
            {branchMenuOpen ? (
              <div className="popover branch-popover" role="listbox" aria-label="Branch">
                <div className="branch-options">
                  {branches.map((branch) => (
                    <button
                      key={branch}
                      type="button"
                      role="option"
                      aria-selected={branch === gitSync.branch}
                      className={`branch-option ${branch === gitSync.branch ? "active" : ""}`}
                      onClick={() => onSwitchBranch(branch, false)}
                    >
                      <span className="branch-option-name">{branch}</span>
                      {branch === gitSync.branch ? <Check size={12} aria-hidden="true" /> : null}
                    </button>
                  ))}
                  {branches.length === 0 ? <span className="branch-empty">No branches yet.</span> : null}
                </div>
                {naming ? (
                  <input
                    className="branch-new"
                    type="text"
                    value={newBranch}
                    autoFocus
                    spellCheck={false}
                    placeholder="new-branch-name"
                    onChange={(event) => setNewBranch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        createBranch();
                      } else if (event.key === "Escape") {
                        // Back to the list, not out of the popover entirely.
                        event.stopPropagation();
                        setNaming(false);
                        setNewBranch("");
                      }
                    }}
                  />
                ) : (
                  <button type="button" className="branch-option new" onClick={() => setNaming(true)}>
                    <Plus size={12} aria-hidden="true" />
                    <span className="branch-option-name">New branch</span>
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
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
