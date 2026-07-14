import { describe, expect, it } from "vitest";
import type { AgentRun, Mission, MissionLoopState, PatchProposal, VerificationRun } from "./domain";
import { compactLabel, roleLabel, workspaceViewFromMissionLoop } from "./workspaceAdapter";

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

  it("chains dependent tasks and connects only chain heads to the repo", () => {
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({}), mission({ id: "m2", depends_on: ["m1"] })] }),
    );
    expect(view.graphEdges).toEqual([
      { id: "r1_m1", from: "r1", to: "m1", kind: "owns" },
      { id: "then_m1_m2", from: "m1", to: "m2", kind: "then" },
    ]);
  });

  it("renders a plan as a node spawning the tasks linked to it", () => {
    const view = workspaceViewFromMissionLoop(
      state({
        plans: [
          {
            id: "plan1",
            repository_id: "r1",
            goal: "add config parsing",
            format: "md",
            content: "## Plan",
            created_at: "2026-07-01T00:00:00Z",
          },
        ],
        missions: [mission({ plan_id: "plan1" }), mission({ id: "m2", plan_id: "plan1", depends_on: ["m1"] })],
      }),
    );
    const planNode = view.graphNodes.find((node) => node.kind === "plan");
    expect(planNode?.id).toBe("plan1");
    expect(planNode?.meta?.taskCount).toBe(2);
    expect(view.graphEdges.filter((edge) => edge.kind === "spawns")).toEqual([
      { id: "plan_plan1_m1", from: "plan1", to: "m1", kind: "spawns" },
      { id: "plan_plan1_m2", from: "plan1", to: "m2", kind: "spawns" },
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
  it("compactLabel keeps the first three words", () => {
    expect(compactLabel("add a version command to the cli")).toBe("add a version");
    expect(compactLabel("  spaced   out  ")).toBe("spaced out");
  });

  it("roleLabel names known workers and passes unknown ones through", () => {
    expect(roleLabel("claude-engineer")).toBe("Engineer");
    expect(roleLabel("custom-worker")).toBe("custom-worker");
  });
});
