import { useRef, useState } from "react";
import { Check, ChevronDown, CornerDownRight, Cpu, FolderGit2, Gauge, SendHorizontal, X } from "lucide-react";
import { AttachmentChips } from "./AttachmentChips";
import { usePastedImages } from "./attachments";
import { useModels } from "../workspace/useModels";
import { effortName, findModel } from "../workspace/models";

type PromptBarProps = {
  repoName?: string;
  repoPath?: string;
  // The selected mission node Create will chain the new mission after, if any.
  followUp?: { id: string; title: string };
  onDismissFollowUp: () => void;
  onCreate: (text: string, attachments: string[]) => void;
  claudeModel: string;
  onPickModel: (model: string) => void;
  modelPickerOpen: boolean;
  onToggleModelPicker: () => void;
  claudeEffort: string;
  onPickEffort: (effort: string) => void;
  effortPickerOpen: boolean;
  onToggleEffortPicker: () => void;
};

export function PromptBar({
  repoName,
  repoPath,
  followUp,
  onDismissFollowUp,
  onCreate,
  claudeModel,
  onPickModel,
  modelPickerOpen,
  onToggleModelPicker,
  claudeEffort,
  onPickEffort,
  effortPickerOpen,
  onToggleEffortPicker,
}: PromptBarProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachments = usePastedImages(repoPath);
  const trimmed = text.trim();
  const ready = Boolean(trimmed) && Boolean(repoName);
  const models = useModels();
  const currentModel = findModel(models, claudeModel);
  // An unset model means the catalog hasn't resolved and Claude Code has no
  // configured model either — the run then follows the CLI's own default.
  const currentModelName = currentModel?.name ?? (claudeModel || "CLI default");
  // Only the levels this model actually accepts; a model with none hides the
  // picker entirely rather than offering a flag that would be rejected.
  const effortLevels = currentModel?.effortLevels ?? [];

  const submit = (action: (value: string, attachments: string[]) => void) => {
    if (!ready) return;
    action(trimmed, attachments.paths);
    setText("");
    attachments.clear();
    inputRef.current?.focus();
  };

  return (
    <div className="prompt-bar" aria-label="New work">
      {followUp ? (
        <div className="attachment-chips">
          <span className="attachment-chip follow-up-chip">
            <CornerDownRight size={12} aria-hidden="true" />
            <span className="attachment-chip-name">follow-up of: {followUp.title}</span>
            <button type="button" onClick={onDismissFollowUp} aria-label="Remove follow-up link">
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        </div>
      ) : null}
      <AttachmentChips paths={attachments.paths} onRemove={attachments.remove} />
      <textarea
        ref={inputRef}
        className="prompt-bar-input"
        aria-label="Describe a task"
        placeholder={repoName ? "Describe a task — Enter creates, Shift+Enter for a new line" : "Open a repository to start"}
        value={text}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        disabled={!repoName}
        onChange={(event) => setText(event.target.value)}
        onPaste={attachments.onPaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit(onCreate);
          }
        }}
      />
      <div className="prompt-bar-actions">
        {repoName ? (
          <span className="prompt-bar-target">
            <FolderGit2 size={13} aria-hidden="true" />
            <span>{repoName}</span>
          </span>
        ) : null}
        <div className="topbar-model">
          <button
            type="button"
            className={`prompt-bar-trigger ${modelPickerOpen ? "active" : ""}`}
            title="Model used by every AI run and chat turn"
            aria-haspopup="listbox"
            aria-expanded={modelPickerOpen}
            onClick={onToggleModelPicker}
          >
            <Cpu size={14} aria-hidden="true" />
            <span>{currentModelName}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {modelPickerOpen ? (
            <div className="popover model-popover" role="listbox" aria-label="Claude model">
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={currentModel?.id === model.id}
                  className={`model-option ${currentModel?.id === model.id ? "active" : ""}`}
                  onClick={() => onPickModel(model.id)}
                >
                  <span className="model-option-name">
                    {model.name}
                    {currentModel?.id === model.id ? <Check size={12} aria-hidden="true" /> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {effortLevels.length > 0 ? (
          <div className="topbar-model">
            <button
              type="button"
              className={`prompt-bar-trigger ${effortPickerOpen ? "active" : ""}`}
              title="Thinking level (--effort) used by every AI run and chat turn"
              aria-haspopup="listbox"
              aria-expanded={effortPickerOpen}
              onClick={onToggleEffortPicker}
            >
              <Gauge size={14} aria-hidden="true" />
              <span>{effortName(claudeEffort)}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            {effortPickerOpen ? (
              <div className="popover model-popover" role="listbox" aria-label="Thinking level">
                {effortLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="option"
                    aria-selected={claudeEffort === level}
                    className={`model-option ${claudeEffort === level ? "active" : ""}`}
                    onClick={() => onPickEffort(level)}
                  >
                    <span className="model-option-name">
                      {effortName(level)}
                      {claudeEffort === level ? <Check size={12} aria-hidden="true" /> : null}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="prompt-bar-send"
          disabled={!ready}
          onClick={() => submit(onCreate)}
          aria-label="Create task"
          title="Create task (Enter)"
        >
          <SendHorizontal size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
