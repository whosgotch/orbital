import { describe, expect, it } from "vitest";
import type { AgentRun, Mission, MissionLoopState, PatchProposal, VerificationRun } from "./domain";
import type { WorkspaceGraphNode, WorkspaceMission } from "./graph";
import { compactLabel, followUpTargetFor, roleLabel, workspaceViewFromMissionLoop } from "./workspaceAdapter";

const emptyState: MissionLoopState = {
  repositories: [],
  missions: [],
  agent_runs: [],
  workflow_events: [],
  patch_proposals: [],
  verification_runs: [],
  chat_messages: [],
};

function mission(overrides: Partial<Mission>): Mission {
  return {
    id: "m1",
    repository_id: "r1",
    text: "add a version command to the cli",
    status: "draft",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function state(overrides: Partial<MissionLoopState>): MissionLoopState {
  return {
    ...emptyState,
    repositories: [{ id: "r1", path: "/tmp/repo", name: "repo", branch: "main", created_at: "2026-07-01T00:00:00Z" }],
    ...overrides,
  };
}

const run: AgentRun = {
  id: "run1",
  mission_id: "m1",
  worker_name: "claude-engineer",
  status: "completed",
  started_at: "2026-07-01T00:01:00Z",
  completed_at: "2026-07-01T00:02:00Z",
};

const pendingPatch: PatchProposal = {
  id: "p1",
  run_id: "run1",
  status: "pending",
  diff: "diff --git a/x b/x",
  created_at: "2026-07-01T00:02:00Z",
  updated_at: "2026-07-01T00:02:00Z",
};

describe("workspaceViewFromMissionLoop", () => {
  it("returns an empty view for a state with no missions", () => {
    const view = workspaceViewFromMissionLoop(emptyState);
    expect(view.missions).toEqual([]);
    expect(view.graphNodes).toEqual([]);
  });

  it("renders a fresh task as repo + task nodes only", () => {
    const view = workspaceViewFromMissionLoop(state({ missions: [mission({})] }));
    expect(view.graphNodes.map((node) => node.kind)).toEqual(["repo", "task"]);
    expect(view.graphEdges).toEqual([{ id: "r1_m1", from: "r1", to: "m1", kind: "owns" }]);
    expect(view.runtimeByMission.m1.status).toBe("draft");
  });

  it("grows agent, changes and verify stages once a run proposes a patch", () => {
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ status: "waiting_approval" })], agent_runs: [run], patch_proposals: [pendingPatch] }),
    );
    expect(view.graphNodes.map((node) => node.kind)).toEqual(["repo", "task", "agent", "changes", "verify"]);
    expect(view.graphEdges.map((edge) => edge.kind)).toEqual(["owns", "runs", "proposes", "verifies"]);
    expect(view.runtimeByMission.m1.status).toBe("review");
    expect(view.patchDiffByMission.m1).toBe(pendingPatch.diff);
    expect(view.commitByMission.m1).toEqual({ hash: "", subject: "" });
  });

  it("surfaces the landed commit once a patch's apply recorded one", () => {
    const appliedPatch: PatchProposal = {
      ...pendingPatch,
      status: "applied",
      commit_hash: "abc1234",
      commit_subject: "add a version command to the cli",
    };
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ status: "applied" })], agent_runs: [run], patch_proposals: [appliedPatch] }),
    );
    expect(view.commitByMission.m1).toEqual({ hash: "abc1234", subject: "add a version command to the cli" });
  });

  it("keeps a tool mission as one node with no pipeline stages", () => {
    const view = workspaceViewFromMissionLoop(
      state({
        missions: [mission({ kind: "tool", tool_command: "npm test", status: "verified" })],
        agent_runs: [{ ...run, worker_name: "local-command" }],
        patch_proposals: [pendingPatch],
      }),
    );
    const kinds = view.graphNodes.map((node) => node.kind);
    expect(kinds).toEqual(["repo", "tool"]);
    expect(view.graphNodes[1].detail).toBe("npm test");
    expect(view.runtimeByMission.m1.status).toBe("verified");
  });

  it("keeps a research mission as one node with no pipeline stages", () => {
    const view = workspaceViewFromMissionLoop(
      state({
        missions: [mission({ kind: "research", text: "how does the plan engine work?", status: "verified" })],
        agent_runs: [{ ...run, worker_name: "claude-researcher" }],
      }),
    );
    expect(view.graphNodes.map((node) => node.kind)).toEqual(["repo", "research"]);
    expect(view.graphEdges.map((edge) => edge.kind)).toEqual(["owns"]);
    expect(view.runtimeByMission.m1.status).toBe("verified");
  });

  it("renders an edge from a verified research node to a task chained onto it", () => {
    const view = workspaceViewFromMissionLoop(
      state({
        missions: [
          mission({ id: "r1", kind: "research", text: "how does the plan engine work?", status: "verified" }),
          mission({ id: "m2", depends_on: ["r1"] }),
        ],
      }),
    );
    expect(view.graphEdges).toContainEqual({ id: "then_r1_m2", from: "r1", to: "m2", kind: "then" });
  });

  it("chains dependent tasks and connects only chain heads to the repo", () => {
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({}), mission({ id: "m2", depends_on: ["m1"] })] }),
    );
    expect(view.graphEdges).toEqual([
      { id: "r1_m1", from: "r1", to: "m1", kind: "owns" },
      { id: "then_m1_m2", from: "m1", to: "m2", kind: "then" },
    ]);
  });

  it("maps verification results onto mission status", () => {
    const verification: VerificationRun = {
      id: "v1",
      mission_id: "m1",
      repository_id: "r1",
      command: "go test ./...",
      status: "failed",
      output: "boom",
      started_at: "2026-07-01T00:03:00Z",
    };
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ status: "applied" })], agent_runs: [run], verification_runs: [verification] }),
    );
    expect(view.runtimeByMission.m1.status).toBe("blocked");
    expect(view.verificationOutputByMission.m1).toBe("boom");
  });
});

describe("labels", () => {
  it("compactLabel keeps a readable sentence head and marks the cut", () => {
    expect(compactLabel("add a version command to the cli")).toBe("add a version command to the…");
    expect(compactLabel("fix the login bug")).toBe("fix the login bug");
    expect(compactLabel("  spaced   out  ")).toBe("spaced out");
  });

  it("roleLabel names known workers and passes unknown ones through", () => {
    expect(roleLabel("claude-engineer")).toBe("Engineer");
    expect(roleLabel("custom-worker")).toBe("custom-worker");
  });
});

describe("followUpTargetFor", () => {
  const workspaceMission = (overrides: Partial<WorkspaceMission>): WorkspaceMission => ({
    id: "m1",
    repository_id: "r1",
    title: "add a version command to the cli",
    status: "draft",
    worker: "claude-engineer",
    command: "",
    files: [],
    step: 0,
    patch_status: "pending",
    verified: false,
    map_position: "center",
    ...overrides,
  });

  const graphNode = (overrides: Partial<WorkspaceGraphNode>): WorkspaceGraphNode => ({
    id: "n1",
    kind: "task",
    label: "add a version",
    detail: "task",
    mission_id: "m1",
    ...overrides,
  });

  it("returns the cleaned title for a selected task node", () => {
    const missions = [workspaceMission({})];
    expect(followUpTargetFor(graphNode({}), missions)).toEqual({
      id: "m1",
      title: "add a version command to the…",
    });
  });

  it("returns a target for a selected research node", () => {
    const missions = [workspaceMission({ id: "m2", title: "fix the login bug" })];
    expect(followUpTargetFor(graphNode({ kind: "research", mission_id: "m2" }), missions)).toEqual({
      id: "m2",
      title: "fix the login bug",
    });
  });

  it("returns undefined for non-mission nodes and no selection", () => {
    const missions = [workspaceMission({})];
    expect(followUpTargetFor(graphNode({ kind: "tool" }), missions)).toBeUndefined();
    expect(followUpTargetFor(graphNode({ kind: "repo", mission_id: undefined }), missions)).toBeUndefined();
    expect(followUpTargetFor(undefined, missions)).toBeUndefined();
  });

  it("returns undefined when the node's mission is missing", () => {
    expect(followUpTargetFor(graphNode({}), [])).toBeUndefined();
  });
});
