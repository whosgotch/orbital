import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { ChangeBadge, DiffView, findFocusFile, parseUnifiedDiff, type DiffFile } from "./DiffView";
import { ReviseBox } from "../chat/ReviseBox";
import type { WorkspaceRuntime } from "../workspace/workspaceAdapter";
import type { WorkspaceMission } from "../canvas/graph";
import type { Repository } from "../workspace/domain";

type DiffModalProps = {
  mission: WorkspaceMission;
  repository: Repository | undefined;
  runtime: WorkspaceRuntime;
  patchReady: boolean;
  patchDiff: string;
  focusedDiffFile: string | undefined;
  chatSending: boolean;
  onSendChat: (text: string) => void;
  onClose: () => void;
  onReject: () => void;
  onApprove: () => void;
};

function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", base: path } : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

function FileRail({
  files,
  selectedPath,
  onSelect,
}: {
  files: DiffFile[];
  selectedPath: string | undefined;
  onSelect: (path: string | undefined) => void;
}) {
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const position = selectedPath ? files.findIndex((file) => file.path === selectedPath) + 1 : 0;

  return (
    <div className="diff-rail">
      <div className="diff-rail-nav">
        <span>{position > 0 ? `${position} / ${files.length}` : "All files"}</span>
        <div className="diff-rail-nav-buttons">
          <button
            type="button"
            className="ghost diff-rail-nav-btn"
            onClick={() => onSelect(position <= 1 ? undefined : files[position - 2].path)}
            disabled={position === 0}
            aria-label="Previous file"
            title="Previous file (k / ↑)"
          >
            <ChevronUp size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ghost diff-rail-nav-btn"
            onClick={() => onSelect(files[position]?.path ?? files[0]?.path)}
            disabled={position === files.length}
            aria-label="Next file"
            title="Next file (j / ↓)"
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="diff-rail-list">
        <button
          type="button"
          className={`diff-rail-item diff-rail-all${selectedPath === undefined ? " active" : ""}`}
          onClick={() => onSelect(undefined)}
        >
          <span className="diff-rail-path">All files</span>
          <span className="diff-file-stat">
            {totalAdditions > 0 ? <span className="diff-add-count">+{totalAdditions}</span> : null}
            {totalDeletions > 0 ? <span className="diff-del-count">−{totalDeletions}</span> : null}
          </span>
        </button>
        {files.map((file) => {
          const { dir, base } = splitPath(file.path);
          return (
            <button
              key={file.path}
              type="button"
              className={`diff-rail-item${selectedPath === file.path ? " active" : ""}`}
              onClick={() => onSelect(file.path)}
              title={file.path}
            >
              <ChangeBadge change={file.change} />
              <span className="diff-rail-path">
                {dir ? <span className="diff-rail-dir">{dir}</span> : null}
                <span className="diff-rail-base">{base}</span>
              </span>
              <span className="diff-file-stat">
                {file.additions > 0 ? <span className="diff-add-count">+{file.additions}</span> : null}
                {file.deletions > 0 ? <span className="diff-del-count">−{file.deletions}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DiffModal({
  mission,
  repository,
  runtime,
  patchReady,
  patchDiff,
  focusedDiffFile,
  chatSending,
  onSendChat,
  onClose,
  onReject,
  onApprove,
}: DiffModalProps) {
  const files = useMemo(
    () => (patchReady && patchDiff.trim() ? parseUnifiedDiff(patchDiff) : []),
    [patchReady, patchDiff],
  );

  // The rail opens on whatever file brought the modal up (or "All files" when
  // there wasn't one). Render-phase reset when the modal's focus target
  // changes, matching the pattern DiffView uses for its own focus prop.
  const [selectedPath, setSelectedPath] = useState(() => findFocusFile(files, focusedDiffFile)?.path);
  const [prevFocus, setPrevFocus] = useState(focusedDiffFile);
  if (prevFocus !== focusedDiffFile) {
    setPrevFocus(focusedDiffFile);
    setSelectedPath(findFocusFile(files, focusedDiffFile)?.path);
  }

  // j/k and the arrow keys walk the file list without reaching for the mouse.
  // Skip while a text field has focus (the revise box) so typing still works,
  // and never touch Escape — App.tsx owns closing the modal on that key.
  useEffect(() => {
    const position = selectedPath ? files.findIndex((file) => file.path === selectedPath) + 1 : 0;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "ArrowDown" || event.key === "j") {
        if (position === files.length) return;
        event.preventDefault();
        setSelectedPath(files[position]?.path ?? files[0]?.path);
      } else if (event.key === "ArrowUp" || event.key === "k") {
        if (position === 0) return;
        event.preventDefault();
        setSelectedPath(position <= 1 ? undefined : files[position - 2].path);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [files, selectedPath]);

  return (
    <div className="diff-modal-backdrop" onClick={onClose}>
      <div className="diff-modal" role="dialog" aria-label="Diff" onClick={(event) => event.stopPropagation()}>
        <div className="diff-modal-head">
          <div>
            <div className="section-label">{repository?.name ?? "workspace"} · review</div>
            <h2>{mission.title}</h2>
          </div>
          <button className="secondary icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="diff-modal-body">
          {files.length > 0 ? <FileRail files={files} selectedPath={selectedPath} onSelect={setSelectedPath} /> : null}
          <div className="diff-modal-main">
            <DiffView
              diff={patchReady ? patchDiff : ""}
              focusPath={focusedDiffFile}
              onlyPath={selectedPath}
              emptyLabel="No changes yet — this mission hasn't reached review."
            />
          </div>
        </div>
        {patchReady && mission.kind !== "tool" ? <ReviseBox sending={chatSending} onSend={onSendChat} /> : null}
        <div className="actions">
          <button className="secondary" type="button" disabled={!patchReady || runtime.patchStatus !== "pending"} onClick={onReject}>
            <X size={16} aria-hidden="true" />
            <span>Reject</span>
          </button>
          <button className="primary" type="button" disabled={!patchReady || runtime.patchStatus !== "pending"} onClick={onApprove}>
            <Check size={16} aria-hidden="true" />
            <span>Approve + apply</span>
          </button>
        </div>
      </div>
    </div>
  );
}
