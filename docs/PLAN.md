# Orbital MVP — the living fabric

## Hypothesis

A canvas the AI weaves itself — and that remembers all work on a repo — beats a chat
on one scenario: vague question → research → tasks → review → merge. Nothing
disappears, and new work links to the old work it builds on.

## Principles

- **Input parity.** The prompt bar and node chats accept everything a chat does:
  text, screenshots, files. Anything less sends the user back to a chat.
- **The canvas is silent for small work.** A quick bug fix never asks for a click.
  Value accumulates like git history — a side effect, not a ceremony.
- **The human edits intents, the AI compiles execution.** Add / remove / connect
  is the whole human vocabulary on the graph. No configuration forms (anti-n8n).
- **Layout.** Prompt bar bottom center (universal intake), node chat docked right,
  all chrome in the top bar, canvas never covered uninvited.

## Blocks

| # | Block | Status |
|---|-------|--------|
| 1 | Layout + persistent canvas: prompt bar, top bar, right-docked node panel, landed nodes stay | **done 2026-07-14** |
| 2 | Research node: read-only run → markdown findings document, rendered + chattable; image attachments | **done 2026-07-14** |
| 3 | Plan sees the graph: existing nodes as planner input, new nodes linked to old, findings flow down edges, follow-up task from a node's chat | **done 2026-07-14** |
| 4 | Intent routing (question → research, task → task) + polish from the friction log | — |

Each block ends in a state that is usable daily.

## Explicitly out of scope (phase 2, only if the fabric proves out)

Cron/triggers and the issue-watcher, MR collector, GitHub/GitLab integration,
human intent nodes with auto-advancing chains, semantic zoom / history clusters.

## Success criterion

Two weeks of all Orbital work done through Orbital. The week-2 friction log must
be shorter than week-1. Still escaping to a chat = hypothesis failed; rebuild
around a different core.

## After the MVP

A cleanup pass: remove leftovers, tighten the project structure, make the
codebase read professionally end to end.
