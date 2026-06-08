# Orbital

Orbital is a visual command center for AI software work.

The product is not another coding chat and not a ticket-to-MR bot. Orbital treats a software project like a living system. Repositories, tasks, tests, agent runs, diffs, approvals, and merge requests are connected parts of one workflow. The user should feel like they are sitting in front of a mission-control panel and commanding software work from there.

## Philosophy

The core object is a mission.

A mission is a high-level software intent, such as:

- add a feature
- investigate a bug
- stabilize an area before release
- generate missing tests
- prepare a merge request

Orbital turns that intent into a visible workflow:

1. understand the repository
2. show the relevant system area
3. plan the work
4. run agent steps
5. show the diff
6. ask for human approval
7. run verification
8. prepare the merge request

The user remains in control. Agents can inspect, plan, edit, and suggest actions, but Orbital must make their work visible and approveable.

## Product Feeling

Orbital should feel like:

- a sci-fi control room
- a command deck
- a living graph of software work
- a workflow where agents are visible workers, not hidden chat responses

The graph is not decoration. It must show actionable relationships:

- missions connected to code areas
- code areas connected to tests
- tests connected to failures
- agent runs connected to files and diffs
- approvals connected to shipping steps

## First Working App

The smallest useful Orbital app should do one workflow end to end on a local repository:

1. Open a local repo.
2. Show a simple graph with repository areas and workflow nodes.
3. Let the user create a mission from text.
4. Run a local agent worker for that mission.
5. Show agent progress as workflow steps.
6. Show the proposed patch immediately.
7. Let the user approve or reject the patch.
8. Let the user run a verification command from the UI.

No Jira, GitHub, CI, cloud, teams, or merge requests are required for the first version. Those come after the local mission loop feels good.

## Initial Architecture

Orbital should be desktop-first.

- UI: React and TypeScript
- desktop shell: Tauri
- local worker: Go
- state: local SQLite or JSON at first
- agent backend: start by reusing GnomeCode concepts

The first worker only needs:

- repo inspection
- file tree/context
- read/search files
- propose patch
- apply patch after approval
- run verification command after approval

## Success Criteria For The First Demo

The first demo is successful if a user can open a repo and see this flow:

1. create mission: "add a version command"
2. graph creates a mission node
3. agent run appears under the mission
4. files read appear as connected nodes
5. proposed patch appears in the UI
6. user approves patch
7. user runs tests
8. mission becomes verified

The demo should feel visual and alive before it becomes powerful.
