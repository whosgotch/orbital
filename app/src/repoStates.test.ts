import { describe, expect, it } from "vitest";
import type { MissionLoopState } from "./domain";
import {
  combineRepoStates,
  emptyMissionLoopState,
  mergeChatMessage,
  mergeWorkflowEvent,
  removeMissionFromState,
  splitByRepository,
  upsertAgentRun,
  upsertPatchProposal,
} from "./repoStates";

// Two repos, one mission each; m1 carries a run with a patch, an event and chat.
const combined: MissionLoopState = {
  repositories: [
    { id: "r1", path: "/a", name: "a", branch: "main", created_at: "t" },
    { id: "r2", path: "/b", name: "b", branch: "main", created_at: "t" },
  ],
  missions: [
    { id: "m1", repository_id: "r1", text: "one", status: "running", created_at: "t", updated_at: "t" },
    { id: "m2", repository_id: "r2", text: "two", status: "draft", created_at: "t", updated_at: "t" },
  ],
  agent_runs: [{ id: "run1", mission_id: "m1", worker_name: "mock", status: "running", started_at: "t" }],
  workflow_events: [
    { id: "e1", run_id: "run1", type: "run_started", message: "", created_at: "t" },
    { id: "e2", mission_id: "m2", type: "run_started", message: "", created_at: "t" },
  ],
  patch_proposals: [{ id: "p1", run_id: "run1", status: "pending", diff: "", created_at: "t", updated_at: "t" }],
  verification_runs: [
    { id: "v1", mission_id: "m1", repository_id: "r1", command: "true", status: "passed", output: "", started_at: "t" },
  ],
  chat_messages: [{ id: "c1", mission_id: "m1", run_id: "run1", role: "user", text: "hi", created_at: "t" }],
};

describe("splitByRepository / combineRepoStates", () => {
  it("slices a combined state into self-contained per-repo states", () => {
    const slices = splitByRepository(combined);
    expect(Object.keys(slices).sort()).toEqual(["r1", "r2"]);

    const r1 = slices.r1;
    expect(r1.missions.map((m) => m.id)).toEqual(["m1"]);
    expect(r1.agent_runs.map((r) => r.id)).toEqual(["run1"]);
    expect(r1.workflow_events.map((e) => e.id)).toEqual(["e1"]);
    expect(r1.patch_proposals.map((p) => p.id)).toEqual(["p1"]);
    expect(r1.verification_runs.map((v) => v.id)).toEqual(["v1"]);
    expect(r1.chat_messages.map((c) => c.id)).toEqual(["c1"]);

    const r2 = slices.r2;
    expect(r2.missions.map((m) => m.id)).toEqual(["m2"]);
    expect(r2.agent_runs).toEqual([]);
    expect(r2.workflow_events.map((e) => e.id)).toEqual(["e2"]);
  });

  it("round-trips: combining the split slices restores every record", () => {
    const roundTripped = combineRepoStates(splitByRepository(combined));
    expect(roundTripped).toEqual(combined);
  });

  it("combines an empty set into the empty state", () => {
    expect(combineRepoStates({})).toEqual(emptyMissionLoopState);
  });
});

describe("live-stream merges", () => {
  it("appends a new workflow event and ignores a replay of the same id", () => {
    const event = { id: "e9", run_id: "run1", mission_id: "m1", type: "agent_thought", message: "thinking", created_at: "t2" } as const;
    const once = mergeWorkflowEvent(combined, event);
    expect(once.workflow_events.map((e) => e.id)).toContain("e9");
    expect(mergeWorkflowEvent(once, event)).toBe(once);
  });

  it("inserts a streamed run and marks its mission running", () => {
    const next = upsertAgentRun(combined, {
      id: "run2",
      mission_id: "m2",
      worker_name: "claude-engineer",
      status: "running",
      started_at: "t2",
    });
    expect(next.agent_runs.map((r) => r.id)).toEqual(["run1", "run2"]);
    expect(next.missions.find((m) => m.id === "m2")?.status).toBe("running");
  });

  it("updates an existing run in place when its status changes", () => {
    const next = upsertAgentRun(combined, {
      id: "run1",
      mission_id: "m1",
      worker_name: "mock",
      status: "completed",
      started_at: "t",
      completed_at: "t3",
    });
    expect(next.agent_runs).toHaveLength(1);
    expect(next.agent_runs[0].status).toBe("completed");
  });

  it("replaces a superseded pending patch and parks the mission at the gate", () => {
    const next = upsertPatchProposal(combined, {
      id: "p2",
      run_id: "run1",
      status: "pending",
      diff: "new diff",
      created_at: "t2",
      updated_at: "t2",
    });
    expect(next.patch_proposals.map((p) => p.id)).toEqual(["p2"]);
    expect(next.missions.find((m) => m.id === "m1")?.status).toBe("waiting_approval");
  });

  it("dedupes chat messages by id", () => {
    const message = { id: "c2", mission_id: "m1", run_id: "run1", role: "assistant", text: "done", created_at: "t2" } as const;
    const once = mergeChatMessage(combined, message);
    expect(once.chat_messages.map((m) => m.id)).toEqual(["c1", "c2"]);
    expect(mergeChatMessage(once, message)).toBe(once);
  });
});

describe("removeMissionFromState", () => {
  it("cascades the delete through runs, events, patches, verifications and chat", () => {
    const next = removeMissionFromState(combined, "m1");
    expect(next.missions.map((m) => m.id)).toEqual(["m2"]);
    expect(next.agent_runs).toEqual([]);
    expect(next.workflow_events.map((e) => e.id)).toEqual(["e2"]);
    expect(next.patch_proposals).toEqual([]);
    expect(next.verification_runs).toEqual([]);
    expect(next.chat_messages).toEqual([]);
    // Repositories stay: closing a mission never closes its repo.
    expect(next.repositories).toHaveLength(2);
  });
});
