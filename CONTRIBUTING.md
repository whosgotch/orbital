# Contributing to Orbital

Orbital is very early and moves fast. Bug reports are the most useful thing you
can send.

## Bug reports and issues

Always welcome. Include your OS, the Orbital version (Releases page or the app's
about line), your `claude --version`, and what you did before it broke. Screenshots
of the canvas help more than descriptions of it.

## Pull requests

Bug fixes and small, self-contained improvements are welcome.

For anything larger — new UI surfaces, new node kinds, changes to the worker
protocol, new dependencies — open an issue first and wait for a reply. Orbital's
direction is driven by a friction log from real daily use, so a technically good
change can still be the wrong change, and finding that out at review time wastes
your work.

## Contributor License Agreement

Your first pull request will prompt you to sign the [CLA](CLA.md). It is a one-time
click. You keep copyright over your contribution and grant the project the right to
relicense it, which keeps Orbital's licensing under single-vendor control.

## Development

The app lives in `app/`; run npm commands from there.

```bash
cd app && npm install && npm run tauri:dev
```

Requires the Rust toolchain (pinned in `rust-toolchain.toml`), Go for the worker,
and an authenticated `claude` binary on your `PATH`.

Before opening a PR:

```bash
npm run lint && npm run test
```

See [AGENTS.md](AGENTS.md) for architecture and repo conventions.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), single line, no
attribution trailers:

```
fix(canvas): keep edge routing straight for near-aligned nodes
```

## Scope

Orbital targets macOS and Linux. There is no Windows build yet, and Windows
support is not currently in scope.
