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
  const [query, setQuery] = useState("");

  // The filter doubles as the name box for a new branch: what you type either
  // narrows the list or, when nothing matches it, is the branch to create.
  const needle = query.trim();
  const matches = branches.filter((branch) => branch.toLowerCase().includes(needle.toLowerCase()));
  const creatable = needle !== "" && !branches.includes(needle);

  const pick = (branch: string, create: boolean) => {
    setQuery("");
    onSwitchBranch(branch, create);
  };

  // Enter takes the obvious one: the only branch left in the list, or the
  // branch the typed name would create.
  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (matches.length === 1) pick(matches[0], false);
    else if (creatable) pick(needle, true);
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
                <input
                  className="branch-filter"
                  type="text"
                  value={query}
                  autoFocus
                  spellCheck={false}
                  placeholder="Find or create a branch…"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onQueryKeyDown}
                />
                <div className="branch-options">
                  {matches.map((branch) => (
                    <button
                      key={branch}
                      type="button"
                      role="option"
                      aria-selected={branch === gitSync.branch}
                      className={`branch-option ${branch === gitSync.branch ? "active" : ""}`}
                      onClick={() => pick(branch, false)}
                    >
                      <span className="branch-option-name">{branch}</span>
                      {branch === gitSync.branch ? <Check size={12} aria-hidden="true" /> : null}
                    </button>
                  ))}
                  {matches.length === 0 && !creatable ? (
                    <span className="branch-empty">No branches match.</span>
                  ) : null}
                </div>
                {creatable ? (
                  <button type="button" className="branch-option create" onClick={() => pick(needle, true)}>
                    <Plus size={12} aria-hidden="true" />
                    <span className="branch-option-name">Create {needle}</span>
                  </button>
                ) : null}
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
