import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileMinus, FilePen, FilePlus } from "lucide-react";
import { highlightLines, languageForPath } from "../ui/highlight";

export type DiffLineKind = "add" | "del" | "context" | "hunk";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  // Hunk lines only: the literal "@@ -a,b +c,d @@" range marker, kept apart
  // from the section heading git puts after it.
  range?: string;
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

  const rows = diff.split("\n");
  // A diff ends with a newline; drop the empty string that split leaves behind
  // so files don't gain a phantom trailing context line.
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();

  for (const raw of rows) {
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
      const match = raw.match(/(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)/);
      if (match) {
        oldNo = parseInt(match[2], 10);
        newNo = parseInt(match[3], 10);
        current.lines.push({ kind: "hunk", range: match[1], text: match[4].trim() });
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

  return files;
}

export function ChangeBadge({ change }: { change: FileChange }) {
  if (change === "added") return <FilePlus size={13} className="diff-change added" aria-hidden="true" />;
  if (change === "deleted") return <FileMinus size={13} className="diff-change deleted" aria-hidden="true" />;
  return <FilePen size={13} className="diff-change modified" aria-hidden="true" />;
}

// Highlight each side of the diff as a whole document: the old side (context +
// deletions) and the new side (context + additions). Lines only make sense in
// the file they came from, so highlighting them together is what keeps
// multi-line syntax honest.
export function highlightDiffLines(lines: DiffLine[], language: string | undefined): string[] {
  const oldRows: number[] = [];
  const newRows: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "hunk") return;
    if (line.kind !== "add") oldRows.push(index);
    if (line.kind !== "del") newRows.push(index);
  });

  const out = new Array<string>(lines.length).fill("");
  const oldHtml = highlightLines(oldRows.map((index) => lines[index].text).join("\n"), language);
  const newHtml = highlightLines(newRows.map((index) => lines[index].text).join("\n"), language);
  // Context lines exist on both sides; the new side wins so they match the
  // additions around them.
  oldRows.forEach((index, position) => {
    out[index] = oldHtml[position] ?? "";
  });
  newRows.forEach((index, position) => {
    out[index] = newHtml[position] ?? "";
  });
  return out;
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
  const code = useMemo(() => highlightDiffLines(file.lines, language), [file.lines, language]);

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
                <>
                  <span className="diff-gutter diff-gutter-old">…</span>
                  <span className="diff-gutter diff-gutter-new">…</span>
                  <span className="diff-hunk-text">
                    <span className="diff-hunk-range">{line.range}</span>
                    {line.text ? <span className="diff-hunk-section">{line.text}</span> : null}
                  </span>
                </>
              ) : (
                <>
                  <span className="diff-gutter diff-gutter-old">{line.kind === "add" ? "" : line.oldNo}</span>
                  <span className="diff-gutter diff-gutter-new">{line.kind === "del" ? "" : line.newNo}</span>
                  <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                  <span
                    className="diff-code hljs"
                    dangerouslySetInnerHTML={{ __html: code[index] || "&nbsp;" }}
                  />
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
