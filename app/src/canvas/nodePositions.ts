// Where the user dragged each card, kept across sessions so reopening a
// repository brings the canvas back the way it was left instead of re-flowing
// every card through the auto-layout. Pins are keyed by node id — the repo and
// mission ids the worker hands out — so a pin outlives anything but its node.
//
// localStorage is the right shelf: this is shell state, the same class as which
// repos were open (recentRepos.ts), and .orbital/ is machine-local anyway.
import type { NodePosition } from "./graphLayout";

const KEY = "orbital:node-positions";

export function loadNodePositions(): Record<string, NodePosition> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isPosition(value))) as Record<string, NodePosition>;
  } catch {
    return {};
  }
}

// A blocked or full store costs the arrangement, never the session.
export function saveNodePositions(positions: Record<string, NodePosition>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(positions));
  } catch {
    /* ignored */
  }
}

// A deleted mission's pin would otherwise sit in the store forever; nothing
// reads it (the canvas only ever restores pins for nodes it renders), so this
// is housekeeping, not correctness.
export function forgetNodePosition(nodeId: string) {
  const { [nodeId]: _dropped, ...rest } = loadNodePositions();
  saveNodePositions(rest);
}

function isPosition(value: unknown): value is NodePosition {
  const position = value as NodePosition | null;
  return typeof position === "object" && position !== null && Number.isFinite(position.x) && Number.isFinite(position.y);
}
