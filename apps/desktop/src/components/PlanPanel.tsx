// Two halves of the repo-planning surface. PlanIntake is where you kick off a
// plan on a repo — a goal and the format the AI should write it in. PlanPanel
// renders a finished plan document faithfully to the format it was authored in.
// An unapproved plan also lists the tasks it proposes, gated behind a review:
// only approving materializes them as draft missions on the canvas.
import { useState } from "react";
import { Check, Loader, Sparkles, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { PlanLiveFeed } from "./PlanLiveFeed";
import type { Plan, PlanFeedItem, PlanFormat } from "../domain";

const FORMATS: { value: PlanFormat; label: string }[] = [
  { value: "md", label: "Markdown" },
  { value: "html", label: "HTML" },
  { value: "text", label: "Text" },
];

// AI-authored HTML is trusted-ish (our own prompt, local tool), but repo content
// could steer it, so strip scripts and inline handlers before rendering.
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

// DocumentView renders an AI-authored document: sanitized HTML when it clearly
// is one, Markdown otherwise. Shared by plans and the research Document tab.
export function DocumentView({ content }: { content: string }) {
  const trimmed = content.trim();
  if (/^<(!doctype|[a-z])/i.test(trimmed)) {
    return <div className="plan-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(trimmed) }} />;
  }
  return <Markdown text={content} />;
}

export function PlanPanel({
  plan,
  taskCount,
  onApprove,
  onDismiss,
}: {
  plan: Plan;
  taskCount: number;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  // Pending review: unapproved and still holding the proposed tasks (older
  // plans, from before this gate existed, fanned out immediately and carry no
  // subtasks — they show no review actions).
  const pending = !plan.approved_at && (plan.subtasks?.length ?? 0) > 0;

  return (
    <aside className="inspector task-window" aria-label="Plan">
      <section className="task-panel plan-panel" aria-label="Plan">
        <div className="panel-head review-head">
          <div>
            <div className="section-label">plan · {plan.format}</div>
            <h2 className="work-order-title">{plan.goal.trim() || "Repo plan"}</h2>
          </div>
          {!pending ? <div className="mini-state">{taskCount} task{taskCount === 1 ? "" : "s"}</div> : null}
        </div>

        <div className="plan-doc">
          {plan.format === "md" ? (
            <Markdown text={plan.content} />
          ) : plan.format === "html" ? (
            <div className="plan-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(plan.content) }} />
          ) : (
            <pre className="plan-text">{plan.content}</pre>
          )}
        </div>

        {pending ? (
          <div className="plan-review">
            <div className="section-label">proposed tasks</div>
            <ul className="plan-proposed-tasks">
              {plan.subtasks!.map((subtask, index) => (
                <li key={index}>{subtask.title.trim() || subtask.text}</li>
              ))}
            </ul>
            <div className="actions">
              <button type="button" className="secondary" onClick={onDismiss}>
                <X size={14} aria-hidden="true" />
                <span>Dismiss</span>
              </button>
              <button type="button" className="primary" onClick={onApprove}>
                <Check size={14} aria-hidden="true" />
                <span>Create {plan.subtasks!.length} task{plan.subtasks!.length === 1 ? "" : "s"}</span>
              </button>
            </div>
          </div>
        ) : taskCount > 0 ? (
          <p className="plan-foot">The tasks this plan proposed are on the canvas — run, edit, or delete them.</p>
        ) : null}
      </section>
    </aside>
  );
}

export function PlanIntake({
  repoName,
  planning,
  feed,
  onPlan,
}: {
  repoName: string;
  planning: boolean;
  feed: PlanFeedItem[];
  onPlan: (goal: string, format: PlanFormat) => void;
}) {
  const [goal, setGoal] = useState("");
  const [format, setFormat] = useState<PlanFormat>("md");

  return (
    <aside className="inspector task-window" aria-label="Plan a repo">
      <section className="task-panel plan-panel" aria-label="Plan a repo">
        <div className="panel-head review-head">
          <div>
            <div className="section-label">plan · {repoName}</div>
            <h2 className="work-order-title">Plan with AI</h2>
          </div>
        </div>

        <p className="plan-intro">
          Not sure where to start? Describe a goal — or leave it blank to let the AI survey the repo — and it will read the
          code and propose a plan plus the tasks to get there.
        </p>

        <textarea
          className="plan-goal"
          aria-label="Planning goal"
          placeholder="e.g. add test coverage to the parser, or leave blank to explore"
          rows={3}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          disabled={planning}
        />

        <div className="plan-format-row">
          <span className="plan-format-label">Format</span>
          <div className="plan-format-options" role="tablist" aria-label="Plan format">
            {FORMATS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={format === option.value}
                className={`plan-format-option ${format === option.value ? "active" : ""}`}
                onClick={() => setFormat(option.value)}
                disabled={planning}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {planning ? <PlanLiveFeed feed={feed} /> : null}

        <button
          type="button"
          className="primary plan-submit"
          onClick={() => onPlan(goal, format)}
          disabled={planning}
        >
          {planning ? <Loader size={15} className="spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
          <span>{planning ? "Planning…" : "Plan repo"}</span>
        </button>
      </section>
    </aside>
  );
}
