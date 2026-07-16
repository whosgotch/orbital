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
    verified: false,
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
  verificationOutputByMission: {},
  verificationCommandByMission: {},
  commitByMission: {},
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
});
