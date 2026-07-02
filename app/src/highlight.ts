// One shared highlight.js core with the languages Orbital cares about, used by
// both the diff renderer and the chat markdown renderer so they stay in sync.
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

// Fence tags people actually type, mapped onto the registered set.
const ALIAS_LANGUAGE: Record<string, string> = {
  shell: "bash", console: "bash", jsonc: "json", golang: "go",
};

export function languageForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANGUAGE[ext];
}

export function languageForTag(tag: string): string | undefined {
  const name = tag.trim().toLowerCase();
  if (!name) return undefined;
  if (hljs.getLanguage(name)) return name;
  return ALIAS_LANGUAGE[name] ?? EXT_LANGUAGE[name];
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Highlight one line or snippet, falling back to escaped text. Per-line
// highlighting can't see multi-line context (block comments, template literals
// spanning lines) — an acceptable trade for a synchronous renderer.
export function highlightCode(text: string, language: string | undefined): string {
  if (text === "") return " ";
  if (!language) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}
