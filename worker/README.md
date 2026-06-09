# Orbital Worker

The worker is the current backend foundation for Orbital's local mission loop.

It can:

- open a local repository
- create a mission
- start the mock worker
- save workflow events and a patch proposal
- approve and apply the patch
- run a verification command
- show saved mission status and timeline

State is stored as JSON under the target repository's `.orbital/` directory.

## Test

```sh
cd worker
GOCACHE=/private/tmp/orbital-go-cache go test ./...
```

`GOCACHE` is optional outside the sandbox, but using it keeps test runs consistent in this workspace.

## Demo

Reset a demo repository:

```sh
cd worker
GOCACHE=/private/tmp/orbital-go-cache go run ./cmd/orbital demo-fixture /private/tmp/orbital-demo-repo
```

Run the local mission loop:

```sh
GOCACHE=/private/tmp/orbital-go-cache go run ./cmd/orbital run /private/tmp/orbital-demo-repo "add a version command" "node -e \"console.log('verified')\""
```

Inspect saved state:

```sh
GOCACHE=/private/tmp/orbital-go-cache go run ./cmd/orbital status /private/tmp/orbital-demo-repo
```

## Current CLI Commands

```sh
orbital demo-fixture <repo-path>
orbital run <repo-path> <mission-text> <verification-command>
orbital status <repo-path>
```

Use `go run ./cmd/orbital ...` from `worker/` until a binary install step exists.

## Current Limitations

- The only registered worker is `mock`.
- The mock worker proposes a fixed demo patch for `package.json` and `src/cli.ts`.
- The demo fixture exists only to make that fixed patch repeatable.
- State is local JSON, not SQLite.
- There is no desktop shell or React UI yet.
- Verification commands are explicit local shell commands run inside the repository path.
