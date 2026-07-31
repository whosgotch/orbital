import { describe, expect, it } from "vitest";
import { enrichGraphNodes } from "./canvasView";
import type { WorkspaceGraphNode, WorkspaceMission } from "./graph";

function taskNode(overrides: Partial<WorkspaceGraphNode> = {}): WorkspaceGraphNode {
  return {
    id: "m1",
    kind: "task",
    label: "add a version command",
    detail: "task",
    mission_id: "m1",
    repository_id: "r1",
    ...overrides,
  };
}

function mission(overrides: Partial<WorkspaceMission> = {}): WorkspaceMission {
  return {
    id: "m1",
    repository_id: "r1",
    title: "add a version command",
    prompt: "add a version command",
    status: "draft",
    worker: "claude-engineer",
    command: "",
    files: [],
    step: 0,
    patch_status: "pending",
    map_position: "center",
    ...overrides,
  };
}

const baseArgs = {
  workspaceGraphNodes: [taskNode()],
  workspaceMissions: [mission()],
  runtimeByMission: {},
  workerModeByMission: {},
  activityByMission: {},
  patchDiffByMission: {},
  commitByMission: {},
  usageByMission: {},
};

describe("enrichGraphNodes", () => {
  it("leaves commitHash unset when the mission has no landed commit", () => {
    const [node] = enrichGraphNodes(baseArgs);
    expect(node.meta?.commitHash).toBeUndefined();
  });

  it("threads the landed commit's hash onto the task node's meta", () => {
    const [node] = enrichGraphNodes({
      ...baseArgs,
      commitByMission: { m1: { hash: "abc1234", subject: "add a version command", branch: "main" } },
    });
    expect(node.meta?.commitHash).toBe("abc1234");
  });

  it("shows a failed task's reason and offers a re-run", () => {
    const [node] = enrichGraphNodes({
      ...baseArgs,
      runtimeByMission: { m1: { step: 0, patchStatus: "pending", status: "blocked", blockedReason: "claude: not found" } },
    });
    expect(node.meta?.error).toBe("claude: not found");
    expect(node.meta?.launchable).toBe(true);
  });

  it("offers a re-run after a rejected patch too — a stopped node is never a dead end", () => {
    const [node] = enrichGraphNodes({
      ...baseArgs,
      runtimeByMission: { m1: { step: 0, patchStatus: "rejected", status: "blocked", blockedReason: "You rejected this patch." } },
    });
    expect(node.meta?.error).toBe("You rejected this patch.");
    expect(node.meta?.launchable).toBe(true);
  });

  it("withholds the re-run while an upstream has not landed — the chain owns it", () => {
    const [, node] = enrichGraphNodes({
      ...baseArgs,
      workspaceGraphNodes: [taskNode(), taskNode({ id: "m2", mission_id: "m2" })],
      workspaceMissions: [mission(), mission({ id: "m2", depends_on: ["m1"] })],
      runtimeByMission: { m2: { step: 0, patchStatus: "pending", status: "blocked", blockedReason: "boom" } },
    });
    expect(node.meta?.launchable).toBe(false);
  });

  it("threads the mission's token usage onto the task node's meta", () => {
    const [node] = enrichGraphNodes({
      ...baseArgs,
      usageByMission: {
        m1: { contextTokens: 48200, inputTokens: 1_150_000, outputTokens: 52_000, totalTokens: 1_200_000, durationMs: 42_000 },
      },
    });
    expect(node.meta?.contextTokens).toBe(48200);
    expect(node.meta?.totalTokens).toBe(1_200_000);
    expect(node.meta?.durationMs).toBe(42_000);
  });

  it("threads the model that ran the mission onto the task node's meta", () => {
    const [node] = enrichGraphNodes({
      ...baseArgs,
      workspaceMissions: [mission({ model: "claude-opus-5" })],
    });
    expect(node.meta?.model).toBe("claude-opus-5");
  });

  it("leaves the model unset until a run has reported one", () => {
    const [node] = enrichGraphNodes(baseArgs);
    expect(node.meta?.model).toBeUndefined();
  });
});
