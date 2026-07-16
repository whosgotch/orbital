// Pasted images pending on a composer: one removable chip per file.
import { Image as ImageIcon, X } from "lucide-react";
import { attachmentName } from "./attachments";

export function AttachmentChips({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  if (paths.length === 0) return null;
  return (
    <div className="attachment-chips">
      {paths.map((path) => (
        <span key={path} className="attachment-chip" title={path}>
          <ImageIcon size={12} aria-hidden="true" />
          <span className="attachment-chip-name">{attachmentName(path)}</span>
          <button type="button" onClick={() => onRemove(path)} aria-label={`Remove ${attachmentName(path)}`}>
            <X size={11} aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}
