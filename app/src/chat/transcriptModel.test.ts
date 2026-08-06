import { describe, expect, it } from "vitest";
import type { AgentRun, ChatMessage, MissionLoopState, WorkflowEvent } from "../workspace/domain";
import { sliceTranscriptByMessage } from "./transcriptModel";

function runFixture(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: "run1",
    mission_id: "m1",
    worker_name: "claude-engineer",
    status: "completed",
    started_at: "2026-07-01T00:00:00Z",
    completed_at: "2026-07-01T00:05:00Z",
    ...overrides,
  };
}

function eventFixture(overrides: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    id: "e1",
    mission_id: "m1",
    run_id: "run1",
    type: "agent_thought",
    message: "thinking",
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function messageFixture(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg1",
    mission_id: "m1",
    run_id: "run1",
    role: "assistant",
    text: "reply",
    created_at: "2026-07-01T00:01:00Z",
    ...overrides,
  };
}

function stateFixture(runs: AgentRun[], events: WorkflowEvent[]): MissionLoopState {
  return {
    repositories: [],
    missions: [],
    agent_runs: runs,
    workflow_events: events,
    patch_proposals: [],
      chat_messages: [],
  };
}

describe("sliceTranscriptByMessage", () => {
  it("assigns each assistant message the events up to and including its own timestamp", () => {
    const events = [
      eventFixture({ id: "e1", created_at: "2026-07-01T00:00:10Z", message: "reading repo" }),
      eventFixture({ id: "e2", created_at: "2026-07-01T00:00:20Z", message: "editing file" }),
      eventFixture({ id: "e3", created_at: "2026-07-01T00:00:30Z", message: "second turn thought" }),
    ];
    const messages = [
      messageFixture({ id: "user1", role: "user", created_at: "2026-07-01T00:00:00Z", text: "go" }),
      messageFixture({ id: "assistant1", role: "assistant", created_at: "2026-07-01T00:00:25Z" }),
      messageFixture({ id: "user2", role: "user", created_at: "2026-07-01T00:00:28Z", text: "more" }),
      messageFixture({ id: "assistant2", role: "assistant", created_at: "2026-07-01T00:00:40Z" }),
    ];
    const state = stateFixture([runFixture({})], events);

    const slices = sliceTranscriptByMessage(state, "m1", messages);

    expect(slices["assistant1"].map((entry) => entry.id)).toEqual(["e1", "e2"]);
    expect(slices["assistant2"].map((entry) => entry.id)).toEqual(["e3"]);
    expect(slices["user1"]).toBeUndefined();
  });

  it("keeps chain of thought as its own kind, apart from narration and tool calls", () => {
    const events = [
      eventFixture({ id: "e1", type: "agent_reasoning", created_at: "2026-07-01T00:00:05Z", message: "weighing options" }),
      eventFixture({ id: "e2", type: "agent_thought", created_at: "2026-07-01T00:00:06Z", message: "Adding the route." }),
      eventFixture({ id: "e3", type: "agent_action", created_at: "2026-07-01T00:00:07Z", message: "Update(main.go)" }),
    ];
    const messages = [messageFixture({ id: "assistant1", created_at: "2026-07-01T00:00:10Z" })];
    const state = stateFixture([runFixture({})], events);

    const slices = sliceTranscriptByMessage(state, "m1", messages);

    expect(slices["assistant1"].map((entry) => entry.kind)).toEqual(["reasoning", "thought", "action"]);
  });

  it("does not filter the window by run_id — a multi-agent turn stays whole", () => {
    const events = [
      eventFixture({ id: "e1", run_id: "manager", created_at: "2026-07-01T00:00:05Z", message: "planning" }),
      eventFixture({ id: "e2", run_id: "engineer", created_at: "2026-07-01T00:00:10Z", message: "implementing" }),
    ];
    const messages = [messageFixture({ id: "assistant1", created_at: "2026-07-01T00:00:15Z" })];
    const state = stateFixture(
      [runFixture({ id: "manager", worker_name: "claude-manager" }), runFixture({ id: "engineer" })],
      events,
    );

    const slices = sliceTranscriptByMessage(state, "m1", messages);

    expect(slices["assistant1"].map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  it("drops events with blank text, matching buildAgentTranscript's filter", () => {
    const events = [
      eventFixture({ id: "e1", created_at: "2026-07-01T00:00:05Z", message: "  " }),
      eventFixture({ id: "e2", created_at: "2026-07-01T00:00:06Z", message: "real thought" }),
    ];
    const messages = [messageFixture({ id: "assistant1", created_at: "2026-07-01T00:00:10Z" })];
    const state = stateFixture([runFixture({})], events);

    const slices = sliceTranscriptByMessage(state, "m1", messages);

    expect(slices["assistant1"].map((entry) => entry.id)).toEqual(["e2"]);
  });

  it("leaves events newer than the last assistant message unassigned (the in-flight turn)", () => {
    const events = [
      eventFixture({ id: "e1", created_at: "2026-07-01T00:00:05Z" }),
      eventFixture({ id: "e2", created_at: "2026-07-01T00:00:50Z", message: "still working" }),
    ];
    const messages = [messageFixture({ id: "assistant1", created_at: "2026-07-01T00:00:10Z" })];
    const state = stateFixture([runFixture({})], events);

    const slices = sliceTranscriptByMessage(state, "m1", messages);

    expect(slices["assistant1"].map((entry) => entry.id)).toEqual(["e1"]);
  });
});
