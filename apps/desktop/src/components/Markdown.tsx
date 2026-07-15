// Full GFM markdown rendering for agent chat replies and research documents:
// tables, nested/task lists, blockquotes, links, and headings beyond h4, on
// top of the fenced-code + inline styling the hand-rolled renderer used to
// cover alone. react-markdown does not render raw HTML, so this stays safe
// against anything a repo or prompt might smuggle into a reply.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode, languageForTag } from "../highlight";

// react-markdown gives code elements a `className` like "language-ts" for
// fenced blocks and no className at all for inline code.
function CodeRenderer({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children).replace(/\n$/, "");
  const match = /language-(\S+)/.exec(className ?? "");
  if (!match) {
    return <code className="md-code">{children}</code>;
  }
  return (
    <pre className="md-pre">
      <code
        className="hljs"
        dangerouslySetInnerHTML={{ __html: highlightCode(text, languageForTag(match[1])) }}
      />
    </pre>
  );
}

// Links open in the OS browser rather than navigating the Tauri webview away
// from the app.
function LinkRenderer({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      className="md-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        if (href) window.open(href);
      }}
    >
      {children}
    </a>
  );
}

function TableRenderer({ children }: { children?: React.ReactNode }) {
  return (
    <div className="md-table-wrap">
      <table className="md-table">{children}</table>
    </div>
  );
}

function heading(level: number) {
  return function Heading({ children }: { children?: React.ReactNode }) {
    const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return <Tag className={`md-heading level-${level}`}>{children}</Tag>;
  };
}

function CheckboxRenderer(props: React.InputHTMLAttributes<HTMLInputElement>) {
  if (props.type !== "checkbox") return <input {...props} />;
  return <input {...props} disabled className="md-checkbox" />;
}

const components: Components = {
  code: CodeRenderer,
  a: LinkRenderer,
  table: TableRenderer,
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  input: CheckboxRenderer,
  img: ({ alt, ...props }) => <img alt={alt ?? ""} className="md-img" {...props} />,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
