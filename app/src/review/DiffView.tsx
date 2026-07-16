import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus } from "lucide-react";
import { escapeHtml, highlightCode, languageForPath } from "../ui/highlight";

export type DiffLineKind = "add" | "del" | "context" | "hunk";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  // Word-level change range [start, end) inside `text`, when this line pairs
  // with its counterpart on the other side of the change.
  markStart?: number;
  markEnd?: number;
};

export type FileChange = "added" | "deleted" | "modified";

export type DiffFile = {
  path: string;
  change: FileChange;
  additions: number;
  deletions: number;
  lines: DiffLine[];
};

// The file picked in chat, on the canvas, or in the diff modal's rail — matched
// by path suffix since event paths and diff paths can differ in their leading
// segments (e.g. a repo-relative path vs. a bare filename).
export function findFocusFile(files: DiffFile[], focusPath: string | undefined): DiffFile | undefined {
  if (!focusPath) return undefined;
  return files.find((file) => file.path === focusPath || file.path.endsWith(focusPath) || focusPath.endsWith(file.path));
}

function stripPrefix(path: string) {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

// Mark what actually changed inside paired del/add lines: the common prefix
// and suffix stay plain, the differing middle gets a highlight. Pairs are only
// made when a run of deletions is followed by an equally long run of additions
// (the classic "edited these lines" shape); anything else stays line-level.
function markIntraline(lines: DiffLine[]) {
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== "del") {
      index += 1;
      continue;
    }
    const delStart = index;
    while (index < lines.length && lines[index].kind === "del") index += 1;
    const addStart = index;
    while (index < lines.length && lines[index].kind === "add") index += 1;

    const delCount = addStart - delStart;
    const addCount = index - addStart;
    if (delCount !== addCount) continue;

    for (let offset = 0; offset < delCount; offset += 1) {
      const del = lines[delStart + offset];
      const add = lines[addStart + offset];
      const a = del.text;
      const b = add.text;
      let prefix = 0;
      while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      // Entirely different lines gain nothing from a full-width mark.
      if (prefix === 0 && suffix === 0) continue;
      del.markStart = prefix;
      del.markEnd = a.length - suffix;
      add.markStart = prefix;
      add.markEnd = b.length - suffix;
    }
  }
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = (path: string): DiffFile => {
    const file: DiffFile = { path, change: "modified", additions: 0, deletions: 0, lines: [] };
    files.push(file);
    return file;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const match = raw.match(/ b\/(.+)$/);
      current = pushFile(match ? match[1] : raw.replace("diff --git ", ""));
      continue;
    }
    if (raw.startsWith("--- ")) {
      if (!current) current = pushFile(stripPrefix(raw.slice(4)));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      // A deleted file's new side is /dev/null; keep the real (old) path.
      const path = stripPrefix(raw.slice(4));
      if (current && path !== "/dev/null") current.path = path;
      continue;
    }
    if (current && raw.startsWith("new file")) {
      current.change = "added";
      continue;
    }
    if (current && raw.startsWith("deleted file")) {
      current.change = "deleted";
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("similarity ") || raw.startsWith("rename ") || raw.startsWith("\\ No newline")) {
      continue;
    }
    if (!current) continue;

    if (raw.startsWith("@@")) {
      const match = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (match) {
        oldNo = parseInt(match[1], 10);
        newNo = parseInt(match[2], 10);
        current.lines.push({ kind: "hunk", text: match[3].trim() });
      }
      continue;
    }

    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), newNo });
      current.additions += 1;
      newNo += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), oldNo });
      current.deletions += 1;
      oldNo += 1;
    } else {
      current.lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }

  for (const file of files) markIntraline(file.lines);
  return files;
}

// Render one code line: syntax highlighting, with the word-level changed range
// wrapped in a mark. Segments are highlighted independently — tokens can split
// at the mark boundary, an acceptable trade for keeping the renderer synchronous.
function lineHtml(line: DiffLine, language: string | undefined): string {
  const { markStart, markEnd, text } = line;
  if (markStart == null || markEnd == null || markStart >= markEnd) {
    return highlightCode(text, language);
  }
  const markClass = line.kind === "add" ? "diff-mark add" : "diff-mark del";
  return (
    highlightCode(text.slice(0, markStart), language) +
    `<span class="${markClass}">` +
    escapeHtml(text.slice(markStart, markEnd)) +
    "</span>" +
    highlightCode(text.slice(markEnd), language)
  );
}

export function ChangeBadge({ change }: { change: FileChange }) {
  if (change === "added") return <FilePlus size={13} className="diff-change added" aria-hidden="true" />;
  if (change === "deleted") return <FileMinus size={13} className="diff-change deleted" aria-hidden="true" />;
  return <FilePen size={13} className="diff-change modified" aria-hidden="true" />;
}

function FileSection({
  file,
  collapsed,
  onToggle,
  sectionRef,
}: {
  file: DiffFile;
  collapsed: boolean;
  onToggle: () => void;
  sectionRef: (node: HTMLDivElement | null) => void;
}) {
  const language = languageForPath(file.path);

  return (
    <div className="diff-file" ref={sectionRef}>
      <button className="diff-file-head" type="button" onClick={onToggle} aria-expanded={!collapsed}>
        {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        <ChangeBadge change={file.change} />
        <span className="diff-file-path" title={file.path}>{file.path}</span>
        <span className="diff-file-stat">
          {file.additions > 0 ? <span className="diff-add-count">+{file.additions}</span> : null}
          {file.deletions > 0 ? <span className="diff-del-count">−{file.deletions}</span> : null}
        </span>
      </button>
      {!collapsed ? (
        <div className="diff-body">
          {file.lines.map((line, index) => (
            <div className={`diff-line ${line.kind}`} key={index}>
              {line.kind === "hunk" ? (
                <span className="diff-hunk-text">{line.text || "…"}</span>
              ) : (
                <>
                  <span className="diff-gutter">{(line.kind === "del" ? line.oldNo : line.newNo) ?? ""}</span>
                  <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                  <span className="diff-code hljs" dangerouslySetInnerHTML={{ __html: lineHtml(line, language) }} />
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DiffView({
  diff,
  emptyLabel,
  focusPath,
  onlyPath,
}: {
  diff: string;
  emptyLabel: string;
  focusPath?: string;
  // When set, render just this one file instead of the whole change set —
  // used by the diff modal's file rail.
  onlyPath?: string;
}) {
  const allFiles = useMemo(() => (diff.trim() ? parseUnifiedDiff(diff) : []), [diff]);
  const files = useMemo(
    () => (onlyPath ? allFiles.filter((file) => file.path === onlyPath) : allFiles),
    [allFiles, onlyPath],
  );
  const signature = files.map((file) => file.path).join("|");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // A new change set starts fully expanded. Render-phase reset (the React
  // "adjust state on prop change" pattern) instead of an effect.
  const [prevSignature, setPrevSignature] = useState(signature);
  if (prevSignature !== signature) {
    setPrevSignature(signature);
    setCollapsed({});
  }

  const focusFile = findFocusFile(files, focusPath);

  // Expand the focused file during render so it is already open when the
  // post-commit effect scrolls to it.
  const [prevFocus, setPrevFocus] = useState(focusPath);
  if (prevFocus !== focusPath) {
    setPrevFocus(focusPath);
    if (focusFile) setCollapsed((current) => ({ ...current, [focusFile.path]: false }));
  }

  useEffect(() => {
    if (!focusFile) return;
    sectionRefs.current[focusFile.path]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusFile]);

  if (files.length === 0) {
    return <div className="diff-empty">{emptyLabel}</div>;
  }

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const allCollapsed = files.every((file) => collapsed[file.path]);

  return (
    <div className="diff-view">
      {files.length > 1 ? (
        <div className="diff-summary">
          <span className="diff-summary-count">
            {files.length} files
            <span className="diff-file-stat">
              {totalAdditions > 0 ? <span className="diff-add-count">+{totalAdditions}</span> : null}
              {totalDeletions > 0 ? <span className="diff-del-count">−{totalDeletions}</span> : null}
            </span>
          </span>
          <button
            type="button"
            className="ghost mini-text"
            onClick={() =>
              setCollapsed(allCollapsed ? {} : Object.fromEntries(files.map((file) => [file.path, true])))
            }
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        </div>
      ) : null}

      {files.map((file) => (
        <FileSection
          key={file.path}
          file={file}
          collapsed={Boolean(collapsed[file.path])}
          onToggle={() => setCollapsed((current) => ({ ...current, [file.path]: !current[file.path] }))}
          sectionRef={(node) => {
            sectionRefs.current[file.path] = node;
          }}
        />
      ))}
    </div>
  );
}
