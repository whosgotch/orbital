// Renders an AI-authored document: sanitized HTML when it clearly is one,
// Markdown otherwise. Used by the research Document tab.
import { Markdown } from "./Markdown";

// AI-authored HTML is trusted-ish (our own prompt, local tool), but repo content
// could steer it, so strip scripts and inline handlers before rendering.
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

export function DocumentView({ content }: { content: string }) {
  const trimmed = content.trim();
  if (/^<(!doctype|[a-z])/i.test(trimmed)) {
    return <div className="plan-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(trimmed) }} />;
  }
  return <Markdown text={content} />;
}
