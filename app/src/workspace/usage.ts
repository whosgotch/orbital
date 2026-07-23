import type { AgentRun } from "./domain";

// The standard Claude context window, used to render context fill as a share of
// capacity. A larger-window model just fills this bar more slowly — never past
// it in practice — so it stays a useful "how full am I" gauge either way.
export const CONTEXT_WINDOW = 200_000;

// A mission's distilled token accounting, ready to render on its node and in
// its status panel. contextTokens is the live context-window fill of the
// mission's active (or last) run; the input/output/total/cost figures sum every
// run the mission owns, so a mission split across runs shows its full spend.
export type MissionUsage = {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

// usageByMission folds each mission's runs into one MissionUsage. Missions with
// no usage yet are simply absent — the UI shows no badge rather than a zero.
export function usageByMission(runs: AgentRun[]): Record<string, MissionUsage> {
  const byMission: Record<string, MissionUsage> = {};
  const withUsage = runs.filter((run) => run.usage);

  for (const run of withUsage) {
    const usage = run.usage!;
    const acc = byMission[run.mission_id] ?? { contextTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    acc.inputTokens += usage.input_tokens;
    acc.outputTokens += usage.output_tokens;
    acc.totalTokens += usage.total_tokens;
    byMission[run.mission_id] = acc;
  }

  // Context fill is a single run's current window occupancy, not a sum: use the
  // mission's most recently started run that reported usage.
  for (const missionId of Object.keys(byMission)) {
    const latest = withUsage
      .filter((run) => run.mission_id === missionId)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .at(-1);
    if (latest?.usage) byMission[missionId].contextTokens = latest.usage.context_tokens;
  }

  return byMission;
}

// formatTokens renders a token count compactly: 820, 48.2k, 1.2M. Sub-10k stays
// exact (rounded to the hundred reads as noise); above that a single decimal.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// contextPercent is the share of the context window currently filled, clamped
// to [0, 100] so an over-window (1M-context) run still renders a sane bar.
export function contextPercent(contextTokens: number): number {
  return Math.max(0, Math.min(100, Math.round((contextTokens / CONTEXT_WINDOW) * 100)));
}

