# Better display for reasoning and tool calls

Proposal only — no implementation yet. Ordered so each block ships on its own.

## What we render today

- `worker/internal/agent/claude_api.go` reduces every stream event to
  `onStep(kind, string)` with `kind` ∈ `thought` | `action`.
- `describeToolUse` formats the call as `Tool(target)` and throws the payload
  away: Bash commands truncate at 120 chars, Edit's old/new strings never
  survive, Grep keeps only the pattern.
- `app/src/chat/AgentTranscript.tsx` maps that string to one of three glyphs
  (`✻ ⏺ ⎿`) and prints a flat list. Pinned per-message under the "reasoning"
  disclosure, live in `AgentStatus`.

Three concrete gaps fall out of that:

1. **We never show real reasoning.** The scanner only reads `text` blocks;
   `thinking` blocks are dropped. What the UI labels "reasoning" is Claude's
   narration to the user — the actual chain of thought is discarded at the
   worker.
2. **Tool calls have no outcome.** `tool_result` lines (on `user` messages) are
   never consumed, so a `Bash(npm test)` that exited 1 renders identically to
   one that passed. The `⎿` glyph exists but nothing ever produces it for a
   tool. A failing run reads as a calm list of things that happened.
3. **Nothing is expandable.** Every step is a lossy one-liner, so there is no
   detail to progressively disclose — the transcript is either a wall or
   nothing.

## Block 1 — a step becomes a record, not a string

Widen `onStep` to carry a struct, and `WorkflowEvent` (Go + `domain.ts`) to
carry the extra fields. Keep `message` as today's one-line summary so the CLI
JSON and every existing consumer keep working unchanged.

New fields: `tool_use_id`, `tool_name`, `status` (`ok` | `error` | `running`),
`duration_ms`, `detail` (bounded JSON: full command, pattern, url, edit
hunk, and the result digest).

Also emit `thinking` blocks under a new kind `reasoning`, distinct from `text`
(kind `narration`). Two different things that must never share a style.

Result digest per tool, one short phrase — `120 lines`, `7 matches`,
`exit 1`, `+12 −3`. This is the payload for the `⎿` line.

## Block 2 — fold call and result into one entry

In `transcriptModel.ts`, join a `tool_use` with its `tool_result` by
`tool_use_id` into a single `ToolStep`, and merge consecutive reasoning blocks
into one paragraph. The view then renders entries, not events.

## Block 3 — the display

**Tool row.** One line: `⏺ Bash(npm test)` in mono, with a dim right-aligned
result `⎿ exit 1 · 4.2s`. Click expands the full input and the result digest.
Errors render red and start expanded — the only case where the transcript
raises its voice. Consecutive same-tool calls collapse: `⏺ Read ×4` expands to
the four paths.

**Reasoning block.** Collapsed to its first line plus `…`, dim and
non-mono so it never reads as a command. Expands in place. Reasoning currently
dominates the pane by volume; collapsing it by default is what makes the tool
spine legible, which is the [glanceable agent] rule.

**Live vs pinned.** Live (in `AgentStatus`): only the tail few rows, with the
in-flight tool row carrying a pulsing glyph. Pinned per message: a one-line
strip — `12 steps · 8 tools · 2 errors` — that expands to the full transcript,
replacing the current unconditional "reasoning" toggle.

## Order

Block 1 + the error half of Block 3 first: a failed tool call being invisible
is a correctness problem, not a polish one. Real `thinking` capture and the
collapse/expand behaviour follow.
