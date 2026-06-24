// A dependency-free unified-diff renderer: parses `git diff` text into files,
// hunks and lines, then renders them with line-number gutters and add/remove
// coloring — the familiar git / GitHub / Cursor look, instead of a raw blob.

type DiffLineKind = "add" | "del" | "context" | "hunk";

type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
};

type DiffFile = {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
};

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
    const file: DiffFile = { path, additions: 0, deletions: 0, lines: [] };
    files.push(file);
    return file;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const match = raw.match(/ b\/(.+)$/);
      current = pushFile(match ? match[1] : raw.replace("diff --git ", ""));
      continue;
    }
    // A bare diff (no `diff --git` line) still starts a file at `---`/`+++`.
    if (raw.startsWith("--- ")) {
      if (!current) current = pushFile(stripPrefix(raw.slice(4)));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (current) current.path = stripPrefix(raw.slice(4));
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity ") || raw.startsWith("rename ") || raw.startsWith("\\ No newline")) {
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
      // Context line (leading space) or a stray blank line inside a hunk.
      current.lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }

  return files;
}

export function DiffView({ diff, emptyLabel }: { diff: string; emptyLabel: string }) {
  const files = diff.trim() ? parseUnifiedDiff(diff) : [];

  if (files.length === 0) {
    return <div className="diff-empty">{emptyLabel}</div>;
  }

  return (
    <div className="diff-view">
      {files.map((file) => (
        <div className="diff-file" key={file.path}>
          <div className="diff-file-head">
            <span className="diff-file-path">{file.path}</span>
            <span className="diff-file-stat">
              {file.additions > 0 ? <span className="diff-add-count">+{file.additions}</span> : null}
              {file.deletions > 0 ? <span className="diff-del-count">−{file.deletions}</span> : null}
            </span>
          </div>
          <div className="diff-body">
            {file.lines.map((line, index) => (
              <div className={`diff-line ${line.kind}`} key={index}>
                {line.kind === "hunk" ? (
                  <span className="diff-hunk-text">{line.text || "…"}</span>
                ) : (
                  <>
                    <span className="diff-gutter">{line.oldNo ?? ""}</span>
                    <span className="diff-gutter">{line.newNo ?? ""}</span>
                    <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                    <span className="diff-code">{line.text || " "}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
