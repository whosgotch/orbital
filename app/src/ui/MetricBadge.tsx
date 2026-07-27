import type { ReactNode } from "react";

// MetricBadge is a small label-over-value cell for a single metric: the name
// sits above the figure. Reusable wherever a compact stat needs a home.
export function MetricBadge({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric-badge">
      <span className="metric-badge-label">{label}</span>
      <span className="metric-badge-value">{value}</span>
    </div>
  );
}
