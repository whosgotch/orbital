import { useRef, useState } from "react";
import { Check, CornerDownLeft, CornerDownRight, Cpu, Gauge, Search, X } from "lucide-react";
import { AttachmentChips } from "./AttachmentChips";
import { usePastedImages } from "./attachments";
import { detectIntent } from "./intent";
import { useModels } from "../workspace/useModels";
import { EFFORT_LEVELS } from "../workspace/models";

type PromptBarProps = {
  repoName?: string;
  repoPath?: string;
  // The selected mission node Create/Research will chain the new mission after, if any.
  followUp?: { id: string; title: string };
  onDismissFollowUp: () => void;
  onCreate: (text: string, attachments: string[]) => void;
  onResearch: (text: string, attachments: string[]) => void;
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
  onResearch,
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
  const intent = detectIntent(trimmed);
  const models = useModels();
  const currentModelName = models.find((model) => model.id === claudeModel)?.name ?? claudeModel;
  const currentEffortName = EFFORT_LEVELS.find((level) => level.id === claudeEffort)?.name ?? claudeEffort;

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
        placeholder={repoName ? "Describe a task — question triggers Research, Enter creates" : "Open a repository to start"}
        value={text}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        disabled={!repoName}
        onChange={(event) => setText(event.target.value)}
        onPaste={attachments.onPaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit(intent === "research" ? onResearch : onCreate);
          }
        }}
      />
      <div className="prompt-bar-actions">
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
            <span>{currentModelName}</span>
          </button>
          {modelPickerOpen ? (
            <div className="popover model-popover" role="listbox" aria-label="Claude model">
              {models.map((model) => (
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
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="topbar-model">
          <button
            type="button"
            className={`chip model-trigger ${effortPickerOpen ? "active" : ""}`}
            title="Thinking level (--effort) used by every AI run and chat turn"
            aria-haspopup="listbox"
            aria-expanded={effortPickerOpen}
            onClick={onToggleEffortPicker}
          >
            <Gauge size={14} aria-hidden="true" />
            <span>{currentEffortName}</span>
          </button>
          {effortPickerOpen ? (
            <div className="popover model-popover" role="listbox" aria-label="Thinking level">
              {EFFORT_LEVELS.map((level) => (
                <button
                  key={level.id}
                  type="button"
                  role="option"
                  aria-selected={claudeEffort === level.id}
                  className={`model-option ${claudeEffort === level.id ? "active" : ""}`}
                  onClick={() => onPickEffort(level.id)}
                >
                  <span className="model-option-name">
                    {level.name}
                    {claudeEffort === level.id ? <Check size={12} aria-hidden="true" /> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {repoName ? <span className="prompt-bar-target">{repoName}</span> : null}
        {intent === "research" ? (
          <button
            type="button"
            className="secondary"
            disabled={!ready}
            onClick={() => submit(onCreate)}
            title="Create task — one per line"
          >
            <CornerDownLeft size={13} aria-hidden="true" />
            <span>Create</span>
          </button>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={!ready}
            onClick={() => submit(onResearch)}
            title="Ask about the repo — a read-only researcher answers with a findings document"
          >
            <Search size={13} aria-hidden="true" />
            <span>Research</span>
          </button>
        )}
        {intent === "research" ? (
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => submit(onResearch)}
            title="Ask about the repo — a read-only researcher answers with a findings document"
          >
            <Search size={13} aria-hidden="true" />
            <span>Research</span>
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => submit(onCreate)}
            title="Create task — one per line"
          >
            <CornerDownLeft size={13} aria-hidden="true" />
            <span>Create</span>
          </button>
        )}
      </div>
    </div>
  );
}
