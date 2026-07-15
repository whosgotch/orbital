// The app's header: brand mark, open-repository tabs, and the panel/model
// controls that live in the top-right corner. Purely presentational — every
// action is a callback prop, every open/closed flag comes in from App state.
import { Check, CircleDot, Cpu, FolderOpen, History, Plus, Rocket, X } from "lucide-react";
import { CURATED_MODELS, modelName } from "../models";
import type { Repository } from "../domain";

type TopBarProps = {
  repositories: Repository[];
  activeRepoPath: string;
  onSelectRepo: (path: string) => void;
  onCloseRepo: (repositoryId: string) => void;
  onChooseFolder: () => void;
  refreshing: boolean;
  launchableCount: number;
  onLaunchAll: () => void;
  draftRepositoryAvailable: boolean;
  onDraftTask: () => void;
  openPanel: null | "mission" | "history";
  onTogglePanel: (panel: "mission" | "history") => void;
  claudeModel: string;
  onPickModel: (model: string) => void;
  modelPickerOpen: boolean;
  onToggleModelPicker: () => void;
};

export function TopBar({
  repositories,
  activeRepoPath,
  onSelectRepo,
  onCloseRepo,
  onChooseFolder,
  refreshing,
  launchableCount,
  onLaunchAll,
  draftRepositoryAvailable,
  onDraftTask,
  openPanel,
  onTogglePanel,
  claudeModel,
  onPickModel,
  modelPickerOpen,
  onToggleModelPicker,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <CircleDot size={16} aria-hidden="true" />
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
        {launchableCount > 1 ? (
          <button className="ghost mini-text" type="button" onClick={onLaunchAll} title="Launch every queued task in parallel">
            Run all
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
        <div className="topbar-model">
          <button
            type="button"
            className={`chip model-trigger ${modelPickerOpen ? "active" : ""}`}
            title="Model used by every AI run and chat turn"
            aria-haspopup="listbox"
            aria-expanded={modelPickerOpen}
            onClick={onToggleModelPicker}
          >
            <Cpu size={14} aria-hidden="true" />
            <span>{modelName(claudeModel)}</span>
          </button>
          {modelPickerOpen ? (
            <div className="popover model-popover" role="listbox" aria-label="Claude model">
              {CURATED_MODELS.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={claudeModel === model.id}
                  className={`model-option ${claudeModel === model.id ? "active" : ""}`}
                  onClick={() => onPickModel(model.id)}
                >
                  <span className="model-option-name">
                    {model.name}
                    {claudeModel === model.id ? <Check size={12} aria-hidden="true" /> : null}
                  </span>
                  <span className="model-option-blurb">{model.blurb}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
