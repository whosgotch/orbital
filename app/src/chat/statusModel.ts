import type { AgentRun, MissionLoopState, WorkflowEvent } from "../workspace/domain";
import type { WorkspaceRuntime } from "../workspace/workspaceAdapter";
import { usageByMission, type MissionUsage } from "../workspace/usage";

export type AgentPhaseStatus = "done" | "active" | "pending" | "failed";
export type AgentPhase = { id: string; label: string; status: AgentPhaseStatus };

export type FileChange = "added" | "modified" | "deleted";
export type TouchedFile = { path: string; change: FileChange; added: number; removed: number };

export type AgentStatusModel = {
  agentLabel: string;
  liveLabel: string;
  isLive: boolean;
  phases: AgentPhase[];
  files: TouchedFile[];
  now: string;
  steps: number;
  elapsed: string;
  hasActivity: boolean;
  // Token accounting for this mission, once an agent has reported any; undefined
  // keeps the panel free of an empty read-out.
  usage?: MissionUsage;
};

// Phases name the act (Plan/Engineer), not the actor (AI manager), so the
// spine reads as a workflow.
function phaseLabel(workerName: string): string {
  switch (workerName) {
    case "claude-manager":
      return "Plan";
    case "claude-engineer":
      return "Engineer";
    case "local-command":
      return "Local";
    default:
      return workerName;
  }
}

function agentLabelFor(workerName: string): string {
  switch (workerName) {
    case "claude-manager":
      return "Claude · Manager";
    case "claude-engineer":
      return "Claude · Engineer";
    case "local-command":
      return "Local agent";
    default:
      return workerName || "Agent";
  }
}

function phaseStatusFromRun(run: AgentRun): AgentPhaseStatus {
  switch (run.status) {
    case "completed":
      return "done";
    case "failed":
    case "cancelled":
      return "failed";
    case "queued":
      return "pending";
    default:
      return "active";
  }
}

// The agent's runs in workflow order: the top-level run (the manager, or the
// sole worker) first, then its children by start time.
function orderedRuns(runs: AgentRun[]): AgentRun[] {
  const top = runs.filter((run) => !run.parent_run_id);
  const children = runs.filter((run) => run.parent_run_id);
  children.sort((a, b) => a.started_at.localeCompare(b.started_at));
  top.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return [...top, ...children];
}

export function parseDiffFiles(diff: string): TouchedFile[] {
  if (!diff.trim()) return [];
  const files: TouchedFile[] = [];
  let current: TouchedFile | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/ b\/(.+)$/);
      const path = match ? match[1] : line.slice("diff --git ".length);
      current = { path, change: "modified", added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) current.change = "added";
    else if (line.startsWith("deleted file mode")) current.change = "deleted";
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }

  return files;
}

function formatElapsed(ms: number): string {
  if (ms <= 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function liveVerb(events: WorkflowEvent[], isLive: boolean, patchPending: boolean): string {
  if (!isLive) {
    if (patchPending) return "awaiting review";
    return "done";
  }
  const last = events[events.length - 1];
  switch (last?.type) {
    case "agent_thought":
      return "thinking";
    case "agent_action":
    case "command_executed":
      return "working";
    case "file_read":
    case "repo_inspected":
      return "reading";
    case "patch_proposed":
      return "proposing patch";
    default:
      return "working";
  }
}

export function buildAgentStatus(
  state: MissionLoopState,
  missionId: string,
  patchDiff: string,
  activity: string[],
  runtime: WorkspaceRuntime | undefined,
): AgentStatusModel {
  const runs = orderedRuns(state.agent_runs.filter((run) => run.mission_id === missionId));
  const runIds = new Set(runs.map((run) => run.id));
  const events = state.workflow_events
    .filter((event) => event.mission_id === missionId || (event.run_id != null && runIds.has(event.run_id)))
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const isLive = runtime?.status === "running";

  // Phase spine. Each run is a phase; a trailing Patch phase reflects the gate.
  const phases: AgentPhase[] = runs.map((run) => ({
    id: run.id,
    label: phaseLabel(run.worker_name),
    status: phaseStatusFromRun(run),
  }));

  const patchPending = (runtime?.patchStatus === "pending" && patchDiff.trim() !== "") || runtime?.status === "review";
  let patchStatus: AgentPhaseStatus = "pending";
  if (runtime?.status === "done" || runtime?.patchStatus === "approved") patchStatus = "done";
  else if (runtime?.patchStatus === "rejected" || runtime?.status === "blocked") patchStatus = "failed";
  else if (patchPending) patchStatus = "active";
  phases.push({ id: "patch", label: "Patch", status: patchStatus });

  // Active agent for the header: the running run, else the last one to act.
  const activeRun = runs.find((run) => run.status === "running") ?? runs[runs.length - 1];
  const agentLabel = activeRun ? agentLabelFor(activeRun.worker_name) : "Agent";

  // Live "now" line and step count prefer the streamed activity (which updates
  // mid-run) over persisted events (which only land when the run finishes).
  const now = activity.length > 0 ? activity[activity.length - 1] : (events[events.length - 1]?.message ?? "");
  const stepEvents = events.filter((event) =>
    event.type === "agent_thought" ||
    event.type === "agent_action" ||
    event.type === "command_executed" ||
    event.type === "file_read",
  );
  const steps = Math.max(activity.length, stepEvents.length);

  const startTimes = runs.map((run) => Date.parse(run.started_at)).filter((t) => !Number.isNaN(t));
  const start = startTimes.length > 0 ? Math.min(...startTimes) : NaN;
  const completions = runs.map((run) => (run.completed_at ? Date.parse(run.completed_at) : NaN));
  const allDone = runs.length > 0 && completions.every((t) => !Number.isNaN(t));
  const end = isLive || !allDone ? Date.now() : Math.max(...completions.filter((t) => !Number.isNaN(t)));
  const elapsed = Number.isNaN(start) ? "" : formatElapsed(end - start);

  return {
    agentLabel,
    liveLabel: liveVerb(events, isLive, patchPending),
    isLive,
    phases,
    files: parseDiffFiles(patchDiff),
    now,
    steps,
    elapsed,
    hasActivity: runs.length > 0 || activity.length > 0 || patchDiff.trim() !== "",
    usage: usageByMission(runs)[missionId],
  };
}
