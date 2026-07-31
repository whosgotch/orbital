import { describe, expect, it } from "vitest";
import type { AgentRun, Mission, MissionLoopState, PatchProposal } from "./domain";
import type { WorkspaceGraphNode, WorkspaceMission } from "../canvas/graph";
import { compactLabel, followUpTargetFor, roleLabel, workspaceViewFromMissionLoop } from "./workspaceAdapter";

const emptyState: MissionLoopState = {
  repositories: [],
  missions: [],
  agent_runs: [],
  workflow_events: [],
  patch_proposals: [],
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

  it("shows an extracted task's own short title, keeping the full text as prompt", () => {
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ title: "Rotate keys", text: "add key rotation for the JWT signer" })] }),
    );
    expect(view.missions[0].title).toBe("Rotate keys");
    expect(view.missions[0].prompt).toBe("add key rotation for the JWT signer");
  });

  it("falls back to the prompt text as the title when a mission has no title", () => {
    const view = workspaceViewFromMissionLoop(state({ missions: [mission({})] }));
    expect(view.missions[0].title).toBe("add a version command to the cli");
    expect(view.missions[0].prompt).toBe("add a version command to the cli");
  });

  it("carries the repository's live branch onto its repo node", () => {
    const view = workspaceViewFromMissionLoop(state({ missions: [mission({})] }));
    const repoNode = view.graphNodes.find((node) => node.kind === "repo");
    expect(repoNode?.meta?.branch).toBe("main");
  });

  it("keeps a mission on one card when a run proposes a patch", () => {
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ status: "waiting_approval" })], agent_runs: [run], patch_proposals: [pendingPatch] }),
    );
    expect(view.graphNodes.map((node) => node.kind)).toEqual(["repo", "task"]);
    expect(view.graphEdges.map((edge) => edge.kind)).toEqual(["owns"]);
    expect(view.runtimeByMission.m1.status).toBe("review");
    expect(view.patchDiffByMission.m1).toBe(pendingPatch.diff);
    expect(view.commitByMission.m1).toEqual({ hash: "", subject: "", branch: "" });
  });

  it("surfaces the landed commit once a patch's apply recorded one", () => {
    const appliedPatch: PatchProposal = {
      ...pendingPatch,
      status: "applied",
      commit_hash: "abc1234",
      commit_subject: "add a version command to the cli",
      branch: "main",
    };
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ status: "applied" })], agent_runs: [run], patch_proposals: [appliedPatch] }),
    );
    expect(view.commitByMission.m1).toEqual({ hash: "abc1234", subject: "add a version command to the cli", branch: "main" });
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
    expect(view.runtimeByMission.m1.status).toBe("done");
  });

  it("reads a legacy research mission as a plain task node", () => {
    const view = workspaceViewFromMissionLoop(
      state({
        missions: [mission({ kind: "research" as never, text: "how does the plan engine work?", status: "verified" })],
      }),
    );
    expect(view.graphNodes.map((node) => node.kind)).toEqual(["repo", "task"]);
    expect(view.missions[0].kind).toBeUndefined();
    expect(view.runtimeByMission.m1.status).toBe("done");
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

  it("reads an applied patch as done — approve + apply is the last step", () => {
    const appliedPatch: PatchProposal = { ...pendingPatch, status: "applied" };
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ status: "applied" })], agent_runs: [run], patch_proposals: [appliedPatch] }),
    );
    expect(view.runtimeByMission.m1.status).toBe("done");
  });

  it("reads a rejected mission as blocked", () => {
    const view = workspaceViewFromMissionLoop(
      state({ missions: [mission({ status: "rejected" })], agent_runs: [run] }),
    );
    expect(view.runtimeByMission.m1.status).toBe("blocked");
  });

  it("carries the failed run's own error as the blocked reason", () => {
    const view = workspaceViewFromMissionLoop(
      state({
        missions: [mission({ status: "failed" })],
        agent_runs: [{ ...run, status: "failed", error: "claude: command not found" }],
      }),
    );
    expect(view.runtimeByMission.m1.blockedReason).toBe("claude: command not found");
  });

  it("falls back to the run_failed event when the run recorded no error", () => {
    const view = workspaceViewFromMissionLoop(
      state({
        missions: [mission({ status: "failed" })],
        agent_runs: [{ ...run, status: "failed" }],
        workflow_events: [
          {
            id: "e1",
            run_id: "run1",
            type: "run_failed",
            message: "Local command failed: exit status 1",
            created_at: "2026-07-01T00:02:00Z",
          },
        ],
      }),
    );
    expect(view.runtimeByMission.m1.blockedReason).toBe("Local command failed: exit status 1");
    // The same message must survive into the activity feed, not be replaced by prose.
    expect(view.activityByMission.m1).toContain("Local command failed: exit status 1");
  });

  it("explains a human rejection and leaves healthy missions without a reason", () => {
    const rejected = workspaceViewFromMissionLoop(
      state({
        missions: [mission({ status: "rejected" })],
        agent_runs: [run],
        patch_proposals: [{ ...pendingPatch, status: "rejected" }],
      }),
    );
    expect(rejected.runtimeByMission.m1.blockedReason).toMatch(/rejected this patch/);

    const running = workspaceViewFromMissionLoop(state({ missions: [mission({ status: "running" })], agent_runs: [run] }));
    expect(running.runtimeByMission.m1.blockedReason).toBeUndefined();
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
    prompt: "add a version command to the cli",
    status: "draft",
    worker: "claude-engineer",
    command: "",
    files: [],
    step: 0,
    patch_status: "pending",
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
