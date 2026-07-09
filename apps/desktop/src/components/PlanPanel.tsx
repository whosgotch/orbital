// Two halves of the repo-planning surface. PlanIntake is where you kick off a
// plan on a repo — a goal and the format the AI should write it in. PlanPanel
// renders a finished plan document faithfully to the format it was authored in,
// alongside the tasks it fanned out to on the canvas.
import { useState } from "react";
import { Loader, Sparkles } from "lucide-react";
import { Markdown } from "./Markdown";
import type { Plan, PlanFormat } from "../domain";

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

export function PlanPanel({ plan, taskCount }: { plan: Plan; taskCount: number }) {
  return (
    <aside className="inspector task-window" aria-label="Plan">
      <section className="task-panel plan-panel" aria-label="Plan">
        <div className="panel-head review-head">
          <div>
            <div className="section-label">plan · {plan.format}</div>
            <h2 className="work-order-title">{plan.goal.trim() || "Repo plan"}</h2>
          </div>
          <div className="mini-state">{taskCount} task{taskCount === 1 ? "" : "s"}</div>
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

        <p className="plan-foot">The tasks this plan proposes are on the canvas — run, break up, or delete them.</p>
      </section>
    </aside>
  );
}

export function PlanIntake({
  repoName,
  planning,
  onPlan,
}: {
  repoName: string;
  planning: boolean;
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
