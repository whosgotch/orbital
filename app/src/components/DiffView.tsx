// A dependency-light unified-diff renderer: parses `git diff` text into files,
// hunks and lines, adds per-line syntax highlighting, and lets you tab between
// changed files — the familiar git / GitHub / Cursor look.
import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import go from "highlight.js/lib/languages/go";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("go", go);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  go: "go", json: "json", css: "css", scss: "css",
  html: "xml", xml: "xml", svg: "xml", vue: "xml",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rs: "rust", md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml",
};

function languageFor(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANGUAGE[ext];
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Highlight a single line. Per-line highlighting can't see multi-line context
// (block comments, template literals spanning lines), which is an acceptable
// trade for a synchronous, diff-friendly renderer.
function highlightLine(text: string, language: string | undefined): string {
  if (text === "") return " ";
  if (!language) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

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
      current.lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }

  return files;
}

export function DiffView({ diff, emptyLabel, focusPath }: { diff: string; emptyLabel: string; focusPath?: string }) {
  const files = useMemo(() => (diff.trim() ? parseUnifiedDiff(diff) : []), [diff]);
  const signature = files.map((file) => file.path).join("|");
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset to the first file whenever the changed-file set changes (new mission).
  useEffect(() => {
    setActiveIndex(0);
  }, [signature]);

  // Jump to a specific file when a file node is clicked (match by path suffix,
  // since event file paths and diff paths can differ in their leading segments).
  useEffect(() => {
    if (!focusPath) return;
    const index = files.findIndex((file) => file.path === focusPath || file.path.endsWith(focusPath) || focusPath.endsWith(file.path));
    if (index >= 0) setActiveIndex(index);
  }, [focusPath, signature]);

  if (files.length === 0) {
    return <div className="diff-empty">{emptyLabel}</div>;
  }

  const active = files[Math.min(activeIndex, files.length - 1)];
  const language = languageFor(active.path);

  return (
    <div className="diff-view">
      {files.length > 1 ? (
        <div className="diff-tabs" role="tablist">
          {files.map((file, index) => (
            <button
              key={file.path}
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              className={`diff-tab ${index === activeIndex ? "active" : ""}`}
              onClick={() => setActiveIndex(index)}
              title={file.path}
            >
              <span className="diff-tab-name">{file.path.split("/").pop()}</span>
              <span className="diff-tab-stat">
                {file.additions > 0 ? <span className="diff-add-count">+{file.additions}</span> : null}
                {file.deletions > 0 ? <span className="diff-del-count">−{file.deletions}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="diff-file">
        {files.length === 1 ? (
          <div className="diff-file-head">
            <span className="diff-file-path">{active.path}</span>
            <span className="diff-file-stat">
              {active.additions > 0 ? <span className="diff-add-count">+{active.additions}</span> : null}
              {active.deletions > 0 ? <span className="diff-del-count">−{active.deletions}</span> : null}
            </span>
          </div>
        ) : null}
        <div className="diff-body">
          {active.lines.map((line, index) => (
            <div className={`diff-line ${line.kind}`} key={index}>
              {line.kind === "hunk" ? (
                <span className="diff-hunk-text">{line.text || "…"}</span>
              ) : (
                <>
                  <span className="diff-gutter">{line.oldNo ?? ""}</span>
                  <span className="diff-gutter">{line.newNo ?? ""}</span>
                  <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                  <span className="diff-code hljs" dangerouslySetInnerHTML={{ __html: highlightLine(line.text, language) }} />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
