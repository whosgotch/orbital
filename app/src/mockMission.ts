import type { MissionLoopState, PatchStatus } from "./domain";

export type MissionNodeStatus = "draft" | "running" | "review" | "approved" | "blocked" | "verified";

export type WorkspaceMission = {
  id: string;
  repository_id: string;
  title: string;
  status: MissionNodeStatus;
  worker: string;
  command: string;
  files: string[];
  step: number;
  patch_status: Extract<PatchStatus, "pending" | "approved" | "rejected">;
  verified: boolean;
  map_position: "north" | "east" | "south" | "west" | "center";
};

export type GraphNodeKind = "repo" | "mission" | "file" | "worker" | "patch" | "verification" | "test";

export type WorkspaceGraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail: string;
  x: number;
  y: number;
  mission_id?: string;
  repository_id?: string;
};

export type WorkspaceGraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "owns" | "reads" | "runs" | "proposes" | "verifies" | "blocks" | "spawns";
};

export const mockMissionLoop: MissionLoopState = {
  repositories: [
    {
      id: "repo_demo",
      path: "/Users/akomov/dev/demo-cli",
      name: "demo-cli",
      branch: "main",
      created_at: "2026-06-11T00:00:00Z",
    },
    {
      id: "repo_worker",
      path: "/Users/akomov/dev/orbital/worker",
      name: "worker",
      branch: "main",
      created_at: "2026-06-11T00:00:00Z",
    },
    {
      id: "repo_app",
      path: "/Users/akomov/dev/orbital/app",
      name: "orbital-app",
      branch: "main",
      created_at: "2026-06-11T00:00:00Z",
    },
  ],
  missions: [],
  agent_runs: [],
  workflow_events: [],
  patch_proposals: [],
  verification_runs: [],
};

export const mockWorkspaceMissions: WorkspaceMission[] = [
  {
    id: "mission_version",
    repository_id: "repo_demo",
    title: "add a version command",
    status: "review",
    worker: "mock",
    command: "npm test",
    files: ["package.json", "src/cli.ts"],
    step: 5,
    patch_status: "pending",
    verified: false,
    map_position: "north",
  },
  {
    id: "mission_status",
    repository_id: "repo_worker",
    title: "stream saved mission status",
    status: "running",
    worker: "mock",
    command: "go test ./...",
    files: ["internal/app/query.go", "cmd/orbital/status.go"],
    step: 2,
    patch_status: "pending",
    verified: false,
    map_position: "east",
  },
  {
    id: "mission_guard",
    repository_id: "repo_worker",
    title: "guard verification state",
    status: "verified",
    worker: "mock",
    command: "go test ./...",
    files: ["internal/app/verification.go"],
    step: 5,
    patch_status: "approved",
    verified: true,
    map_position: "south",
  },
  {
    id: "mission_deck",
    repository_id: "repo_app",
    title: "make command map feel alive",
    status: "running",
    worker: "mock",
    command: "npm run build",
    files: ["src/App.tsx", "src/styles.css"],
    step: 3,
    patch_status: "pending",
    verified: false,
    map_position: "center",
  },
  {
    id: "mission_tauri",
    repository_id: "repo_app",
    title: "prepare desktop shell bridge",
    status: "draft",
    worker: "unassigned",
    command: "npm run build",
    files: ["src-tauri/tauri.conf.json"],
    step: -1,
    patch_status: "pending",
    verified: false,
    map_position: "west",
  },
  {
    id: "mission_apply",
    repository_id: "repo_worker",
    title: "harden patch apply errors",
    status: "blocked",
    worker: "mock",
    command: "go test ./...",
    files: ["internal/app/patch.go"],
    step: 4,
    patch_status: "rejected",
    verified: false,
    map_position: "west",
  },
];

export const mockRepoMetrics = {
  repo_demo: { areas: 4, tests: 18 },
  repo_worker: { areas: 7, tests: 41 },
  repo_app: { areas: 5, tests: 1 },
};

export const mockGraphNodes: WorkspaceGraphNode[] = [
  { id: "repo_demo", kind: "repo", label: "demo-cli", detail: "source zone", x: 10, y: 24, repository_id: "repo_demo" },
  { id: "mission_version", kind: "mission", label: "version command", detail: "mission", x: 25, y: 24, mission_id: "mission_version", repository_id: "repo_demo" },
  { id: "file_package", kind: "file", label: "package.json", detail: "context", x: 40, y: 18, mission_id: "mission_version", repository_id: "repo_demo" },
  { id: "file_cli", kind: "file", label: "src/cli.ts", detail: "context", x: 40, y: 30, mission_id: "mission_version", repository_id: "repo_demo" },
  { id: "worker_mock", kind: "worker", label: "mock worker", detail: "processor", x: 56, y: 24 },
  { id: "patch_gate", kind: "patch", label: "patch assembly", detail: "approval gate", x: 72, y: 24, mission_id: "mission_version" },
  { id: "verify_gate", kind: "verification", label: "verify station", detail: "npm test", x: 89, y: 24, mission_id: "mission_version" },
  { id: "repo_worker", kind: "repo", label: "worker", detail: "source zone", x: 10, y: 52, repository_id: "repo_worker" },
  { id: "mission_status", kind: "mission", label: "saved status", detail: "mission", x: 25, y: 46, mission_id: "mission_status", repository_id: "repo_worker" },
  { id: "mission_apply", kind: "mission", label: "patch apply", detail: "blocked", x: 25, y: 58, mission_id: "mission_apply", repository_id: "repo_worker" },
  { id: "file_agent", kind: "file", label: "agent_run.go", detail: "context", x: 42, y: 46, mission_id: "mission_status", repository_id: "repo_worker" },
  { id: "mission_guard", kind: "mission", label: "verification guard", detail: "verified", x: 58, y: 58, mission_id: "mission_guard", repository_id: "repo_worker" },
  { id: "go_tests", kind: "test", label: "go test", detail: "test station", x: 82, y: 52, repository_id: "repo_worker" },
  { id: "repo_app", kind: "repo", label: "orbital-app", detail: "source zone", x: 10, y: 80, repository_id: "repo_app" },
  { id: "mission_deck", kind: "mission", label: "command map", detail: "mission", x: 27, y: 76, mission_id: "mission_deck", repository_id: "repo_app" },
  { id: "mission_tauri", kind: "mission", label: "desktop bridge", detail: "queued", x: 27, y: 88, mission_id: "mission_tauri", repository_id: "repo_app" },
  { id: "file_app", kind: "file", label: "App.tsx", detail: "context", x: 46, y: 76, mission_id: "mission_deck", repository_id: "repo_app" },
];

export const mockGraphEdges: WorkspaceGraphEdge[] = [
  { id: "edge_demo_version", from: "repo_demo", to: "mission_version", kind: "owns" },
  { id: "edge_version_package", from: "mission_version", to: "file_package", kind: "reads" },
  { id: "edge_version_cli", from: "mission_version", to: "file_cli", kind: "reads" },
  { id: "edge_context_worker_package", from: "file_package", to: "worker_mock", kind: "runs" },
  { id: "edge_context_worker_cli", from: "file_cli", to: "worker_mock", kind: "runs" },
  { id: "edge_worker_patch", from: "worker_mock", to: "patch_gate", kind: "proposes" },
  { id: "edge_patch_verify", from: "patch_gate", to: "verify_gate", kind: "verifies" },
  { id: "edge_worker_status", from: "repo_worker", to: "mission_status", kind: "owns" },
  { id: "edge_worker_apply", from: "repo_worker", to: "mission_apply", kind: "owns" },
  { id: "edge_status_agent", from: "mission_status", to: "file_agent", kind: "reads" },
  { id: "edge_status_tests", from: "mission_status", to: "go_tests", kind: "verifies" },
  { id: "edge_apply_block", from: "mission_apply", to: "go_tests", kind: "blocks" },
  { id: "edge_worker_guard", from: "mission_guard", to: "go_tests", kind: "verifies" },
  { id: "edge_app_deck", from: "repo_app", to: "mission_deck", kind: "owns" },
  { id: "edge_app_tauri", from: "repo_app", to: "mission_tauri", kind: "owns" },
  { id: "edge_deck_app", from: "mission_deck", to: "file_app", kind: "reads" },
];

export const mockWorkflowSteps = [
  "Mission intent captured.",
  "Worker linked to repository graph.",
  "Repository context streamed.",
  "Code area locked.",
  "Patch assembled.",
  "Patch waiting at approval gate.",
];

export const mockPatchDiff = `diff --git a/package.json b/package.json
index 2b13a1c..91d44fd 100644
--- a/package.json
+++ b/package.json
@@ -4,6 +4,7 @@
   "bin": {
     "demo": "./dist/cli.js"
   },
+  "version": "0.1.0",
   "scripts": {
     "build": "tsc",
     "test": "vitest run"
diff --git a/src/cli.ts b/src/cli.ts
index 8b891fa..7f1c0db 100644
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -1,6 +1,11 @@
 import pkg from "../package.json";

 const command = process.argv[2];

+if (command === "version" || command === "--version") {
+  console.log(pkg.version);
+  process.exit(0);
+}
+
 console.log("Usage: demo <command>");`;

export const mockVerificationOutput = `> npm test

 PASS  src/cli.test.ts
  version command prints 0.1.0

Test Files  1 passed
Duration    0.8s`;
