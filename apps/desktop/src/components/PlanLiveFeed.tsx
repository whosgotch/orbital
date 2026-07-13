// Live view of the AI planning: the streamed steps arriving over the
// plan_event channel, newest last, glyphed like the agent transcript
// (✻ thought, ⏺ action). Motion is text updating — nothing animates.
import type { PlanFeedItem } from "../domain";

const VISIBLE_LINES = 6;

export function PlanLiveFeed({ feed }: { feed: PlanFeedItem[] }) {
  const tail = feed.slice(-VISIBLE_LINES);
  return (
    <div className="plan-live nodrag nowheel" aria-label="AI planning live">
      <div className="plan-live-now">⏺ planning{feed.length > 0 ? ` · ${feed.length} steps` : "…"}</div>
      {tail.map((item, index) => (
        <div key={feed.length - tail.length + index} className={`plan-live-line ${item.kind}`}>
          {item.kind === "thought" ? "✻" : "⏺"} {item.text}
        </div>
      ))}
    </div>
  );
}
