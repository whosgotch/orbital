// A dependency-light markdown renderer for agent chat replies: fenced code
// blocks (syntax-highlighted), lists, headings, inline code/bold/italic.
// Deliberately small — chat needs readable answers, not a full spec.
import { Fragment, useMemo, type ReactNode } from "react";
import { highlightCode, languageForTag } from "../highlight";

type Block =
  | { kind: "code"; language?: string; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string };

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "code", language: languageForTag(fence[1]), text: body.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const items: string[] = [(bullet ?? numbered)![1]];
      while (i + 1 < lines.length) {
        const next = lines[i + 1].match(ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*]\s+(.*)$/);
        if (!next) break;
        items.push(next[1]);
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

// Inline markdown: `code`, **bold**, *italic*. Rendered as real React nodes so
// only highlighted code blocks ever go through innerHTML.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let key = 0;

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={key} className="md-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    key += 1;
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            <pre key={index} className="md-pre">
              <code
                className="hljs"
                dangerouslySetInnerHTML={{ __html: highlightCode(block.text, block.language) }}
              />
            </pre>
          );
        }
        if (block.kind === "heading") {
          return (
            <div key={index} className={`md-heading level-${block.level}`}>
              {renderInline(block.text)}
            </div>
          );
        }
        if (block.kind === "list") {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ));
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        return (
          <p key={index}>
            {block.text.split("\n").map((line, lineIndex, all) => (
              <Fragment key={lineIndex}>
                {renderInline(line)}
                {lineIndex < all.length - 1 ? <br /> : null}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
