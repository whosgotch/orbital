import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens, usageByMission } from "./usage";
import type { AgentRun } from "./domain";

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: "run_1",
    mission_id: "m1",
    worker_name: "claude-engineer",
    status: "completed",
    started_at: "2026-07-23T10:00:00Z",
    ...overrides,
  };
}

describe("usageByMission", () => {
  it("sums totals across a mission's runs and takes the latest run's context fill", () => {
    const runs: AgentRun[] = [
      run({
        id: "run_a",
        started_at: "2026-07-23T10:00:00Z",
        duration_ms: 4200,
        usage: { context_tokens: 5000, input_tokens: 6000, output_tokens: 70, total_tokens: 6070, cost_usd: 0.12 },
      }),
      run({
        id: "run_b",
        started_at: "2026-07-23T11:00:00Z",
        duration_ms: 1800,
        usage: { context_tokens: 9000, input_tokens: 10000, output_tokens: 100, total_tokens: 10100, cost_usd: 0.2 },
      }),
    ];

    const byMission = usageByMission(runs);
    // Context is the later run's fill, not a sum.
    expect(byMission.m1.contextTokens).toBe(9000);
    // Input/output/total/cost accumulate across the mission's runs.
    expect(byMission.m1.inputTokens).toBe(16000);
    expect(byMission.m1.outputTokens).toBe(170);
    expect(byMission.m1.totalTokens).toBe(16170);
    // Duration sums the mission's runs.
    expect(byMission.m1.durationMs).toBe(6000);
  });

  it("omits missions whose runs have no usage yet", () => {
    expect(usageByMission([run({ usage: undefined })])).toEqual({});
  });
});

describe("formatTokens", () => {
  it("renders compactly across magnitudes", () => {
    expect(formatTokens(820)).toBe("820");
    expect(formatTokens(4820)).toBe("4.8k");
    expect(formatTokens(48200)).toBe("48k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});

describe("formatDuration", () => {
  it("renders sub-minute with one decimal", () => {
    expect(formatDuration(4200)).toBe("4.2s");
  });
  it("renders minutes with zero-padded seconds", () => {
    expect(formatDuration(63_000)).toBe("1m 03s");
  });
  it("rolls whole seconds into the minute rather than showing 60s", () => {
    expect(formatDuration(119_600)).toBe("2m 00s");
  });
  it("renders hours with zero-padded minutes", () => {
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });
});

