---
name: verify
description: Build and drive the orbital worker CLI end-to-end against a scratch repo to verify worker behavior changes.
---

# Verify the worker CLI

The worker's surface is the `orbital` CLI (the Tauri app shells out to it and consumes the full-state JSON every command prints).

## Build

```bash
cd worker && go build -o /tmp/orbital ./cmd/orbital
```

## Scratch repo

Any small git repo works; `orbital open` registers it and creates `.orbital/` state inside it:

```bash
mkdir demo && cd demo && git init && <add a couple of source files> && git commit -am init
/tmp/orbital open "$PWD"
/tmp/orbital queue "$PWD" "some task text"          # add --tool "cmd" for a tool step
/tmp/orbital link "$PWD" <from-id> <to-id>          # make <to> depend on <from>
/tmp/orbital status --json "$PWD"                   # inspect full state anytime
```

Mission ids are in the JSON every command prints (`missions[].id`).

## Drive

- `decompose`, `plan`, `run`, `start-run` make real `claude` CLI calls — allow ~1–3 min each; `--model` is optional (empty = claude default).
- Every mutating command prints the entire refreshed state JSON — pipe through python/jq and assert on `missions`, `plans`, `depends_on`, `plan_id` rather than eyeballing.
- Error paths are cheap: unknown mission id, tool mission where a task is required, and missing args all exit 1 with a one-line `error:`.

## Gotchas

- State lives in `<repo>/.orbital/`; delete it (or use a fresh scratch repo) to reset between scenarios.
- `--tool`/`--campaign` flags go after the positional args.
