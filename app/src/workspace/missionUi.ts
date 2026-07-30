// Pure mappers from mission runtime to the labels, pills and statuses the
// panels render. No React, no state — App.tsx calls these from JSX.
import type { Repository } from "./domain";
import type { MissionNodeStatus, WorkspaceMission } from "../canvas/graph";
import type { WorkspaceRuntime } from "./workspaceAdapter";

// The runtime a mission has before its first run touches it.
export const queuedRuntime: WorkspaceRuntime = { step: -1, patchStatus: "pending", status: "queued" };

export type WorkerMode = "local-command" | "claude-engineer";

// Map a mission's actual worker name to the selectable mode, so the per-mission
// dropdown reflects whoever last ran it (any claude-* agent reads as Claude).
export function workerModeFromName(workerName: string | undefined): WorkerMode {
  return workerName === "local-command" ? "local-command" : "claude-engineer";
}

export function workerModeLabel(mode: WorkerMode): string {
  return mode === "local-command" ? "Local cmd" : "Claude AI";
}


export function repositoryFor(mission: WorkspaceMission, repositories: Repository[]) {
  return repositories.find((repository) => repository.id === mission.repository_id) ?? repositories[0];
}

export function statusFromRuntime(runtime: WorkspaceRuntime): MissionNodeStatus {
  if (runtime.status === "blocked") {
    return "blocked";
  }
  if (runtime.status === "done") {
    return "done";
  }
  if (runtime.patchStatus === "approved") {
    return "done";
  }
  if (runtime.patchStatus === "rejected") {
    return "blocked";
  }
  if (runtime.status === "review") {
    return "review";
  }
  if (runtime.step >= 0) {
    return "running";
  }
  if (runtime.status === "queued") {
    return "queued";
  }
  return "draft";
}


export function missionStatusFor(runtime: WorkspaceRuntime, patchReady: boolean) {
  const status = statusFromRuntime(runtime);
  if (status === "done") {
    // Approve + apply is the last step a patch has, so say what happened to it.
    // Tool missions never produce one — they just finish.
    return { label: patchReady ? "Applied" : "Done", className: "done" };
  }
  if (status === "blocked") {
    return { label: "Blocked", className: "rejected" };
  }
  if (status === "review") {
    return { label: patchReady ? "Review" : "Running", className: "active" };
  }
  if (status === "running") {
    return { label: "Running", className: "active" };
  }
  return { label: "Queued", className: "idle" };
}


export function defaultLocalCommand() {
  return `printf 'diff --git a/orbital-local-worker.txt b/orbital-local-worker.txt\nnew file mode 100644\n--- /dev/null\n+++ b/orbital-local-worker.txt\n@@ -0,0 +1 @@\n+local worker completed\n' > "$ORBITAL_PATCH_PATH"`;
}

export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallback;
}
