# Working on Orbital

Orbital is a desktop app for running AI coding missions on a canvas: a Tauri
shell around a React frontend, driven by a Go CLI worker that owns all state
and git operations.

## Layout

| Path | What it is |
|---|---|
| `apps/desktop/src` | React 19 + TypeScript frontend (vite, vitest, ESLint) |
| `apps/desktop/src-tauri` | Rust Tauri v2 shell; invokes the worker binary |
| `worker/` | Go CLI (`orbital`); missions, runs, patches, git worktrees |
| `docs/` | User-facing documentation |
| `.plans/` | Internal design notes |
| `scripts/` | Repo tooling (`check.sh` = full local gate, `install.sh` = installer) |

## Commands

- Full gate (what CI runs): `scripts/check.sh`
- Frontend: `cd apps/desktop && npm test -- --run && npm run lint && npx tsc --noEmit`
- Worker: `cd worker && go test ./...`
- Rust shell: `cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
- Dev app: `cd apps/desktop && npm run tauri:dev`

## Conventions

- Conventional Commits, single line: `type(scope): subject`. No AI attribution.
  Commit after every self-contained change; keep PRs small.
- Comments state constraints the code can't show — no narration.
- Long-running Tauri commands must be `async fn` + `spawn_blocking`, or the UI
  freezes.
- React code must pass the React Compiler ESLint rules (no setState-in-effect).
- The worker CLI prints full JSON state; the frontend consumes it via
  `status --json`. Field names are Go json tags (snake_case).
