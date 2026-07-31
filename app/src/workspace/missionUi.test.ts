import { describe, expect, it } from "vitest";
import { statusFromRuntime } from "./missionUi";

describe("statusFromRuntime", () => {
  it("reads a re-run as running, not as the rejection it is retrying", () => {
    expect(statusFromRuntime({ step: 0, patchStatus: "rejected", status: "running" })).toBe("running");
  });

  it("still reads a stopped mission with a rejected patch as blocked", () => {
    expect(statusFromRuntime({ step: 0, patchStatus: "rejected", status: "draft" })).toBe("blocked");
  });

  it("keeps the terminal statuses ahead of everything else", () => {
    expect(statusFromRuntime({ step: 2, patchStatus: "pending", status: "blocked" })).toBe("blocked");
    expect(statusFromRuntime({ step: 2, patchStatus: "pending", status: "done" })).toBe("done");
    expect(statusFromRuntime({ step: -1, patchStatus: "pending", status: "queued" })).toBe("queued");
  });
});
