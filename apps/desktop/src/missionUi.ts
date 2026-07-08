// Pure mappers from mission runtime to the labels, pills and statuses the
// panels render. No React, no state — App.tsx calls these from JSX.
import type { Repository } from "./domain";
import type { MissionNodeStatus, WorkspaceMission } from "./graph";
import type { WorkspaceRuntime } from "./workspaceAdapter";

// The runtime a mission has before its first run touches it.
export const queuedRuntime: WorkspaceRuntime = { step: -1, patchStatus: "pending", verified: false, status: "queued" };

export type WorkerMode = "mock" | "local-command" | "claude-manager";

// Map a mission's actual worker name to the selectable mode, so the per-mission
// dropdown reflects whoever last ran it (any claude-* agent reads as Claude).
export function workerModeFromName(workerName: string | undefined): WorkerMode {
  if (workerName === "local-command") return "local-command";
  if (workerName?.startsWith("claude")) return "claude-manager";
  return "mock";
}

export function workerModeLabel(mode: WorkerMode): string {
  if (mode === "local-command") return "Local cmd";
  if (mode === "claude-manager") return "Claude AI";
  return "Demo worker";
}


export function repositoryFor(mission: WorkspaceMission, repositories: Repository[]) {
  return repositories.find((repository) => repository.id === mission.repository_id) ?? repositories[0];
}

export function statusFromRuntime(runtime: WorkspaceRuntime): MissionNodeStatus {
  if (runtime.status === "blocked") {
    return "blocked";
  }
  if (runtime.status === "verified") {
    return "verified";
  }
  if (runtime.verified) {
    return "verified";
  }
  if (runtime.patchStatus === "approved") {
    return "approved";
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
  if (status === "verified") {
    return { label: "Verified", className: "done" };
  }
  if (status === "approved") {
    return { label: "Approved", className: "active" };
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

export function verifyPillLabel(runtime: WorkspaceRuntime) {
  if (runtime.verified) return "Verification passed";
  if (runtime.status === "blocked") return "Verification failed";
  if (runtime.patchStatus === "approved") return "Not verified yet";
  return "Awaiting verification";
}

export function verifyPillClass(runtime: WorkspaceRuntime) {
  if (runtime.verified) return "passed";
  if (runtime.status === "blocked") return "failed";
  if (runtime.patchStatus === "approved") return "ready";
  return "pending";
}

export function verificationOutput(runtime: WorkspaceRuntime, output: string) {
  if (runtime.verified) {
    return output || "Verification passed.";
  }
  if (runtime.status === "blocked") {
    return output || "Mission blocked before verification completed.";
  }
  if (runtime.patchStatus === "approved") {
    return "Patch approved. Verification command is armed.";
  }
  if (runtime.patchStatus === "rejected") {
    return "Patch rejected. Mission stopped before file changes.";
  }
  return "Waiting for approved patch.";
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
