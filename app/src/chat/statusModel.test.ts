import { describe, expect, it } from "vitest";
import type { AgentRun, MissionLoopState } from "../workspace/domain";
import { buildAgentStatus, parseDiffFiles } from "./statusModel";

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old line
+new line
 context
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+one
+two
`;

describe("parseDiffFiles", () => {
  it("summarises each touched file with change kind and counts", () => {
    expect(parseDiffFiles(diff)).toEqual([
      { path: "src/a.ts", change: "modified", added: 1, removed: 1 },
      { path: "src/b.ts", change: "added", added: 2, removed: 0 },
    ]);
  });

  it("returns nothing for a blank diff", () => {
    expect(parseDiffFiles("  \n")).toEqual([]);
  });
});

function runFixture(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: "run1",
    mission_id: "m1",
    worker_name: "claude-manager",
    status: "completed",
    started_at: "2026-07-01T00:00:00Z",
    completed_at: "2026-07-01T00:05:00Z",
    ...overrides,
  };
}

function stateFixture(runs: AgentRun[]): MissionLoopState {
  return {
    repositories: [],
    missions: [],
    agent_runs: runs,
    workflow_events: [],
    patch_proposals: [],
      chat_messages: [],
  };
}

describe("buildAgentStatus", () => {
  it("builds a phase spine of manager, children and the patch gate", () => {
    const runs = [
      runFixture({}),
      runFixture({ id: "run2", worker_name: "claude-engineer", parent_run_id: "run1", started_at: "2026-07-01T00:01:00Z" }),
    ];
    const model = buildAgentStatus(stateFixture(runs), "m1", "", [], {
      step: 3,
      patchStatus: "pending",
      status: "review",
    });
    expect(model.phases.map((phase) => phase.label)).toEqual(["Plan", "Engineer", "Patch"]);
    expect(model.phases.map((phase) => phase.status)).toEqual(["done", "done", "active"]);
    expect(model.elapsed).toBe("5m00s");
  });

  it("marks the patch phase done once the patch is applied", () => {
    const model = buildAgentStatus(stateFixture([runFixture({})]), "m1", "", [], {
      step: 3,
      patchStatus: "approved",
      status: "done",
    });
    expect(model.phases.at(-1)).toEqual({ id: "patch", label: "Patch", status: "done" });
    expect(model.isLive).toBe(false);
    expect(model.liveLabel).toBe("done");
  });

  it("prefers the streamed activity for the now line", () => {
    const model = buildAgentStatus(stateFixture([runFixture({ status: "running", completed_at: undefined })]), "m1", "", [
      "reading src/App.tsx",
      "editing src/App.tsx",
    ], { step: 1, patchStatus: "pending", status: "running" });
    expect(model.now).toBe("editing src/App.tsx");
    expect(model.isLive).toBe(true);
    expect(model.agentLabel).toBe("Claude · Manager");
  });

  it("reports no activity for an untouched mission", () => {
    const model = buildAgentStatus(stateFixture([]), "m1", "", [], undefined);
    expect(model.hasActivity).toBe(false);
    expect(model.phases).toEqual([{ id: "patch", label: "Patch", status: "pending" }]);
  });
});
