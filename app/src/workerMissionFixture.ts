import type { MissionLoopState } from "./domain";

export const workerMissionFixture = {
  repositories: [
    {
      id: "repo_demo",
      path: "/private/tmp/orbital-demo-repo",
      name: "orbital-demo-repo",
      branch: "main",
      created_at: "2026-06-12T09:00:00Z",
    },
  ],
  missions: [
    {
      id: "mission_version",
      repository_id: "repo_demo",
      text: "add a version command",
      status: "verified",
      created_at: "2026-06-12T09:01:00Z",
      updated_at: "2026-06-12T09:06:00Z",
    },
  ],
  agent_runs: [
    {
      id: "run_version",
      mission_id: "mission_version",
      worker_name: "mock",
      status: "completed",
      started_at: "2026-06-12T09:02:00Z",
      completed_at: "2026-06-12T09:04:00Z",
    },
  ],
  workflow_events: [
    {
      id: "event_run_started",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "run_started",
      message: "Mock worker started.",
      created_at: "2026-06-12T09:02:00Z",
    },
    {
      id: "event_repo_inspected",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "repo_inspected",
      message: "Repository inspected.",
      created_at: "2026-06-12T09:02:15Z",
    },
    {
      id: "event_package_read",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "file_read",
      message: "Read package metadata.",
      file_path: "package.json",
      created_at: "2026-06-12T09:02:30Z",
    },
    {
      id: "event_cli_read",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "file_read",
      message: "Read CLI entrypoint.",
      file_path: "src/cli.ts",
      created_at: "2026-06-12T09:02:45Z",
    },
    {
      id: "event_patch_proposed",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "patch_proposed",
      message: "Patch proposed.",
      created_at: "2026-06-12T09:03:00Z",
    },
    {
      id: "event_run_completed",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "run_completed",
      message: "Mock worker completed.",
      created_at: "2026-06-12T09:04:00Z",
    },
    {
      id: "event_patch_approved",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "patch_approved",
      message: "Patch approved.",
      created_at: "2026-06-12T09:04:30Z",
    },
    {
      id: "event_patch_applied",
      mission_id: "mission_version",
      run_id: "run_version",
      type: "patch_applied",
      message: "Patch applied.",
      created_at: "2026-06-12T09:05:00Z",
    },
    {
      id: "event_verification_run",
      mission_id: "mission_version",
      type: "verification_run",
      message: "Verification command started.",
      command: "npm test",
      created_at: "2026-06-12T09:05:30Z",
    },
    {
      id: "event_verification_passed",
      mission_id: "mission_version",
      type: "verification_passed",
      message: "Verification passed.",
      command: "npm test",
      created_at: "2026-06-12T09:06:00Z",
    },
  ],
  patch_proposals: [
    {
      id: "patch_version",
      run_id: "run_version",
      status: "applied",
      diff: `diff --git a/package.json b/package.json
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
@@ -1,5 +1,10 @@
 import pkg from "../package.json";
 
 const command = process.argv[2];
 
+if (command === "version" || command === "--version") {
+  console.log(pkg.version);
+  process.exit(0);
+}
+
 console.log("Usage: demo <command>");`,
      created_at: "2026-06-12T09:03:00Z",
      updated_at: "2026-06-12T09:05:00Z",
    },
  ],
  verification_runs: [
    {
      id: "verification_version",
      mission_id: "mission_version",
      repository_id: "repo_demo",
      command: "npm test",
      status: "passed",
      exit_code: 0,
      output: `> npm test

 PASS  src/cli.test.ts
  version command prints 0.1.0

Test Files  1 passed
Duration    0.8s`,
      started_at: "2026-06-12T09:05:30Z",
      completed_at: "2026-06-12T09:06:00Z",
    },
  ],
} satisfies MissionLoopState;
