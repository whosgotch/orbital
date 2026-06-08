const steps = [
  "Mission created from local intent.",
  "Inspecting package scripts.",
  "Reading package.json.",
  "Reading src/cli.ts.",
  "Preparing patch for version command.",
  "Patch ready for approval.",
];

const diff = `diff --git a/package.json b/package.json
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

const state = {
  step: -1,
  patchStatus: "pending",
  verified: false,
};

const nodes = {
  mission: document.querySelector(".mission-node"),
  run: document.querySelector(".run-node"),
  files: document.querySelectorAll(".file-node"),
  patch: document.querySelector(".patch-node"),
  verify: document.querySelector(".verify-node"),
};

const missionText = document.getElementById("missionText");
const missionTitle = document.getElementById("missionTitle");
const graphMission = document.getElementById("graphMission");
const missionNodeText = document.getElementById("missionNodeText");
const runNodeText = document.getElementById("runNodeText");
const patchNodeText = document.getElementById("patchNodeText");
const verifyNodeText = document.getElementById("verifyNodeText");
const activityList = document.getElementById("activityList");
const diffText = document.getElementById("diffText");
const statusBadge = document.getElementById("statusBadge");
const patchState = document.getElementById("patchState");
const testOutput = document.getElementById("testOutput");

const startMission = document.getElementById("startMission");
const advanceStep = document.getElementById("advanceStep");
const approvePatch = document.getElementById("approvePatch");
const rejectPatch = document.getElementById("rejectPatch");
const runTests = document.getElementById("runTests");

function setNode(node, className) {
  node.classList.remove("pending", "active", "working", "done", "rejected");
  node.classList.add(className);
}

function setBadge(text, className) {
  statusBadge.textContent = text;
  statusBadge.className = `status-badge ${className}`;
}

function setPatchState(text, className) {
  patchState.textContent = text;
  patchState.className = `mini-state ${className}`;
}

function renderActivity() {
  activityList.innerHTML = "";
  steps.slice(0, state.step + 1).forEach((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    activityList.appendChild(item);
  });
}

function render() {
  renderActivity();
  missionTitle.textContent = missionText.value.trim() || "Untitled mission";
  graphMission.textContent = missionTitle.textContent;

  setNode(nodes.mission, state.step >= 0 ? "active" : "pending");
  setNode(nodes.run, state.step >= 1 ? "working" : "pending");
  nodes.files.forEach((node, index) => {
    setNode(node, state.step >= index + 2 ? "done" : "pending");
  });

  missionNodeText.textContent = state.step >= 0 ? "active" : "waiting";
  runNodeText.textContent = state.step >= 5 ? "patch proposed" : state.step >= 1 ? "working" : "not started";

  if (state.patchStatus === "approved") {
    setNode(nodes.patch, "done");
    setPatchState("Approved", "done");
    patchNodeText.textContent = "approved";
  } else if (state.patchStatus === "rejected") {
    setNode(nodes.patch, "rejected");
    setPatchState("Rejected", "rejected");
    patchNodeText.textContent = "rejected";
  } else {
    setNode(nodes.patch, state.step >= 5 ? "active" : "pending");
    setPatchState(state.step >= 5 ? "Ready" : "Pending", state.step >= 5 ? "active" : "");
    patchNodeText.textContent = state.step >= 5 ? "ready" : "queued";
  }

  if (state.verified) {
    setNode(nodes.verify, "done");
    verifyNodeText.textContent = "passed";
    setBadge("Verified", "done");
  } else if (state.patchStatus === "approved") {
    setNode(nodes.verify, "active");
    verifyNodeText.textContent = "ready";
    setBadge("Approved", "active");
  } else if (state.patchStatus === "rejected") {
    setNode(nodes.verify, "rejected");
    verifyNodeText.textContent = "stopped";
    setBadge("Rejected", "rejected");
  } else if (state.step >= 0) {
    setNode(nodes.verify, "pending");
    verifyNodeText.textContent = "blocked";
    setBadge(state.step >= 5 ? "Review" : "Running", "active");
  } else {
    setNode(nodes.verify, "pending");
    verifyNodeText.textContent = "blocked";
    setBadge("Draft", "idle");
  }

  diffText.textContent = state.step >= 5 ? diff : "Patch will appear after the agent finishes inspection.";
  approvePatch.disabled = state.step < 5 || state.patchStatus !== "pending";
  rejectPatch.disabled = state.step < 5 || state.patchStatus !== "pending";
  runTests.disabled = state.patchStatus !== "approved" || state.verified;
  advanceStep.disabled = state.step >= steps.length - 1 || state.patchStatus !== "pending";
}

startMission.addEventListener("click", () => {
  state.step = 0;
  state.patchStatus = "pending";
  state.verified = false;
  testOutput.textContent = "Waiting for approved patch.";
  render();
});

advanceStep.addEventListener("click", () => {
  if (state.step < steps.length - 1) {
    state.step += 1;
    render();
  }
});

approvePatch.addEventListener("click", () => {
  state.patchStatus = "approved";
  testOutput.textContent = "Patch approved. Verification command is ready.";
  render();
});

rejectPatch.addEventListener("click", () => {
  state.patchStatus = "rejected";
  testOutput.textContent = "Patch rejected. Mission stopped before file changes.";
  render();
});

runTests.addEventListener("click", () => {
  state.verified = true;
  testOutput.textContent = `> npm test

 PASS  src/cli.test.ts
  version command prints 0.1.0

Test Files  1 passed
Duration    0.8s`;
  render();
});

render();
