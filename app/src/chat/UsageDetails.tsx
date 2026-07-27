import { MetricBadge } from "../ui/MetricBadge";
import { CONTEXT_WINDOW, contextPercent, formatTokens, type MissionUsage } from "../workspace/usage";

// UsageDetails is the node's full token read-out for the side panel: a context
// gauge (fill vs. the model's window) plus the cumulative input/output/total
// across the mission's runs. Renders nothing when the mission has no usage yet,
// so idle and just-created nodes stay clean. No dollar figure — Orbital runs
// Claude under a subscription, where per-token cost isn't real spend.
export function UsageDetails({ usage }: { usage?: MissionUsage }) {
  if (!usage) return null;

  const percent = contextPercent(usage.contextTokens);

  return (
    <div className="usage-details" aria-label="Token usage">
      <div className="usage-details-head">
        <span className="usage-details-title">Usage</span>
      </div>

      {usage.contextTokens > 0 ? (
        <div className="usage-context">
          <div className="usage-context-labels">
            <span>Context window</span>
            <span className="usage-context-figure">
              {formatTokens(usage.contextTokens)} / {formatTokens(CONTEXT_WINDOW)} · {percent}%
            </span>
          </div>
          <div className="usage-gauge" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="usage-gauge-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}

      <div className="usage-grid">
        <MetricBadge label="Input" value={formatTokens(usage.inputTokens)} />
        <MetricBadge label="Output" value={formatTokens(usage.outputTokens)} />
        <MetricBadge label="Total" value={formatTokens(usage.totalTokens)} />
      </div>
    </div>
  );
}
