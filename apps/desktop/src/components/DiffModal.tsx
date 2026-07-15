// The wide diff review modal: full patch, a revise box to send another chat
// turn, and the approve/reject actions — the same gate as the task panel's
// Changes tab, popped out full-screen.
import { Check, X } from "lucide-react";
import { DiffView } from "./DiffView";
import { ReviseBox } from "./ReviseBox";
import type { WorkspaceRuntime } from "../workspaceAdapter";
import type { WorkspaceMission } from "../graph";
import type { Repository } from "../domain";

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
        <DiffView diff={patchReady ? patchDiff : ""} focusPath={focusedDiffFile} emptyLabel="No changes yet — this mission hasn't reached review." />
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
