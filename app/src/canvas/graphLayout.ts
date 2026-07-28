import dagre from "@dagrejs/dagre";
import type { GraphNodeKind, WorkspaceGraphEdge, WorkspaceGraphNode } from "./graph";

export type NodePosition = { x: number; y: number };

export const NODE_WIDTH = 236;
// Footprint for a card the canvas has not measured yet. Real heights arrive
// from React Flow (GraphMap passes them in) because cards grow with their
// content — a finished task card is nearly twice this tall, and laying it out
// as 118px is what used to stack lanes on top of each other.
export const NODE_HEIGHT = 118;
// Repo/campaign cards are wallpaper: styles.css fixes their height so their
// port row is a constant, not a function of whether a branch chip is showing.
export const REPO_HEIGHT = 100;

// Distance from a card's top edge to its handles. styles.css pins the handles
// at exactly these offsets — edges come out straight only while the two agree.
const PORT_Y = 59;
const REPO_PORT_Y = REPO_HEIGHT / 2;

export function portOffset(kind: GraphNodeKind): number {
  return kind === "repo" || kind === "campaign" ? REPO_PORT_Y : PORT_Y;
}

const COL_GAP = 72; // horizontal gap between pipeline stages
const ROW_GAP = 28; // vertical gap between branches inside one lane
export const LANE_GAP = 64; // vertical gap between mission lanes
const COL_STEP = NODE_WIDTH + COL_GAP; // distance between aligned columns

function rectsOverlapVertically(top1: number, bottom1: number, top2: number, bottom2: number): boolean {
  return top1 < bottom2 && top2 < bottom1;
}

// Aligned swimlanes: every mission is its own lane, and each node snaps to a
// GLOBAL column (its longest-path depth from the repo) so the same pipeline
// stage lines up vertically across every lane. Vertical placement within a
// lane comes from a dagre pass run in PORT-ROW space: cards are hung off their
// port row rather than centered, so a pipeline's ports stay collinear however
// tall its individual cards grow. `pinned` carries the top-left positions of
// user-dragged nodes (GraphMap's manualPositionsRef): lanes with no pinned
// members are pushed clear of them so a freshly spawned lane never lands
// under a pin. `heights` carries measured card heights by node id; anything
// missing falls back to NODE_HEIGHT. Returns top-left positions keyed by id.
export function layoutGraph(
  nodes: WorkspaceGraphNode[],
  edges: WorkspaceGraphEdge[],
  pinned: Record<string, NodePosition> = {},
  heights: Record<string, number> = {},
): Record<string, NodePosition> {
  const present = new Set(nodes.map((node) => node.id));
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]));
  const portOf = (id: string) => portOffset(kindById.get(id) ?? "task");
  const heightOf = (id: string) =>
    heights[id] ?? (kindById.get(id) === "repo" || kindById.get(id) === "campaign" ? REPO_HEIGHT : NODE_HEIGHT);
  // Dagre centers a node on its rank coordinate, but we hang cards off their
  // port row. Reserving the taller half on both sides makes dagre's box cover
  // wherever the card actually lands, so ROW_GAP stays a real gap.
  const dagreHeightOf = (id: string) => 2 * Math.max(portOf(id), heightOf(id) - portOf(id));

  const parents = new Map<string, string[]>();
  nodes.forEach((node) => parents.set(node.id, []));
  edges.forEach((edge) => {
    if (present.has(edge.from) && present.has(edge.to)) parents.get(edge.to)!.push(edge.from);
  });

  // Global column = longest path from a root (repo). Memoized, guarded against
  // accidental cycles so layout never hangs.
  const columnCache = new Map<string, number>();
  const inFlight = new Set<string>();
  const columnOf = (id: string): number => {
    if (columnCache.has(id)) return columnCache.get(id)!;
    if (inFlight.has(id)) return 0;
    inFlight.add(id);
    const ps = parents.get(id) ?? [];
    const value = ps.length === 0 ? 0 : 1 + Math.max(...ps.map(columnOf));
    inFlight.delete(id);
    columnCache.set(id, value);
    return value;
  };
  nodes.forEach((node) => columnOf(node.id));

  const repoNodes = nodes.filter((node) => node.kind === "repo");

  // Bucket non-repo nodes into mission lanes, in first-appearance ("creation")
  // order — this is both the fallback order and the sibling/root order the
  // dependency-aware sort below uses.
  const creationOrder: string[] = [];
  const laneNodes = new Map<string, WorkspaceGraphNode[]>();
  for (const node of nodes) {
    if (node.kind === "repo" || !node.mission_id) continue;
    if (!laneNodes.has(node.mission_id)) {
      laneNodes.set(node.mission_id, []);
      creationOrder.push(node.mission_id);
    }
    laneNodes.get(node.mission_id)!.push(node);
  }
  const repoOfLane = (missionId: string) => laneNodes.get(missionId)?.[0]?.repository_id ?? "";

  // Dependency-aware lane order: repo grouping still outranks everything (a
  // family never spans repos), but within a repo, lanes are ordered by a
  // depth-first walk of the mission-level DAG built from cross-lane "then"
  // edges (chain heads and their extracted/chained tasks), starting from
  // roots (no in-repo upstream) in creation order — so a chain's lanes stay
  // contiguous right after their root instead of scattering by mission id.
  const missionChildren = new Map<string, string[]>();
  const missionParents = new Map<string, string[]>();
  edges.forEach((edge) => {
    if (edge.kind !== "then") return;
    if (!laneNodes.has(edge.from) || !laneNodes.has(edge.to)) return;
    if (!missionChildren.has(edge.from)) missionChildren.set(edge.from, []);
    missionChildren.get(edge.from)!.push(edge.to);
    if (!missionParents.has(edge.to)) missionParents.set(edge.to, []);
    missionParents.get(edge.to)!.push(edge.from);
  });
  const creationIndex = new Map(creationOrder.map((id, index) => [id, index]));

  const repos = Array.from(new Set(creationOrder.map((id) => repoOfLane(id)))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const laneOrder: string[] = [];
  for (const repo of repos) {
    const groupIds = creationOrder.filter((id) => repoOfLane(id) === repo);
    const groupSet = new Set(groupIds);
    const roots = groupIds.filter((id) => (missionParents.get(id) ?? []).every((parent) => !groupSet.has(parent)));
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id) || !groupSet.has(id)) return;
      visited.add(id);
      laneOrder.push(id);
      const children = (missionChildren.get(id) ?? [])
        .filter((child) => groupSet.has(child))
        .sort((a, b) => creationIndex.get(a)! - creationIndex.get(b)!);
      children.forEach(visit);
    };
    roots.forEach(visit);
    // Cycle guard: anything unreached (shouldn't happen outside a cycle)
    // still gets placed, in creation order.
    groupIds.forEach((id) => {
      if (!visited.has(id)) {
        visited.add(id);
        laneOrder.push(id);
      }
    });
  }

  const tops: Record<string, number> = {};

  // Phase A: per-lane dagre pass gives each node's card top relative to its
  // own lane's top, independent of where that lane ends up sitting.
  type LaneInfo = { height: number; offsets: Map<string, number>; hasPinned: boolean };
  const laneInfo = new Map<string, LaneInfo>();
  for (const missionId of laneOrder) {
    const lane = laneNodes.get(missionId)!;
    const laneSet = new Set(lane.map((node) => node.id));

    // Dagre gives the vertical arrangement; we ignore its x and use columns.
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: COL_GAP, marginx: 0, marginy: 0 });
    graph.setDefaultEdgeLabel(() => ({}));
    lane.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: dagreHeightOf(node.id) }));
    edges.forEach((edge) => {
      if (laneSet.has(edge.from) && laneSet.has(edge.to)) graph.setEdge(edge.from, edge.to);
    });
    dagre.layout(graph);

    // The dagre box is symmetric around the port row, so its center IS the
    // port row: nodes dagre ranked level get collinear ports, whatever their
    // heights, and the card hangs off that row.
    const cardTop = (id: string) => graph.node(id).y - portOf(id);
    let minTop = Infinity;
    let maxBottom = -Infinity;
    lane.forEach((node) => {
      minTop = Math.min(minTop, cardTop(node.id));
      maxBottom = Math.max(maxBottom, cardTop(node.id) + heightOf(node.id));
    });

    const offsets = new Map<string, number>();
    lane.forEach((node) => offsets.set(node.id, cardTop(node.id) - minTop));

    laneInfo.set(missionId, {
      height: maxBottom - minTop,
      offsets,
      hasPinned: lane.some((node) => node.id in pinned),
    });
  }

  // Phase B: stack lanes top-to-bottom in order, as if there were no pins.
  const originalTop = new Map<string, number>();
  let cursor = 0;
  for (const missionId of laneOrder) {
    originalTop.set(missionId, cursor);
    cursor += laneInfo.get(missionId)!.height + LANE_GAP;
  }

  // Phase C: any lane with no pinned members is pushed down past pinned nodes
  // it would otherwise overlap; the push cascades to every lane after it so
  // lane order (and spacing) is preserved. Lanes that themselves hold a pin
  // are left at their original stacked position — the pin already put a node
  // there, and GraphMap overrides pinned members' positions regardless.
  const pinnedRects = Object.entries(pinned).map(([id, pos]) => ({ top: pos.y, bottom: pos.y + heightOf(id) }));
  const finalTop = new Map<string, number>();
  let shiftSoFar = 0;
  for (const missionId of laneOrder) {
    const info = laneInfo.get(missionId)!;
    let top = originalTop.get(missionId)! + shiftSoFar;
    if (!info.hasPinned && pinnedRects.length > 0) {
      let moved = true;
      let guard = 0;
      while (moved && guard <= pinnedRects.length) {
        moved = false;
        for (const rect of pinnedRects) {
          if (rectsOverlapVertically(top, top + info.height, rect.top, rect.bottom)) {
            const candidate = rect.bottom + LANE_GAP;
            if (candidate > top) {
              top = candidate;
              moved = true;
            }
          }
        }
        guard += 1;
      }
    }
    finalTop.set(missionId, top);
    shiftSoFar = top - originalTop.get(missionId)!;
  }

  // Phase D: place every lane's nodes at their final band, and collect each
  // repo's mission PORT ROWS for the repo-node average below — averaging port
  // rows (not card tops) is what makes a single-mission repo edge dead level.
  const repoPortRows = new Map<string, number[]>();
  for (const missionId of laneOrder) {
    const lane = laneNodes.get(missionId)!;
    const info = laneInfo.get(missionId)!;
    const top = finalTop.get(missionId)!;
    lane.forEach((node) => {
      tops[node.id] = top + info.offsets.get(node.id)!;
    });

    const missionNode = lane.find((node) => node.kind === "task");
    if (missionNode?.repository_id) {
      const rows = repoPortRows.get(missionNode.repository_id) ?? [];
      rows.push(tops[missionNode.id] + portOf(missionNode.id));
      repoPortRows.set(missionNode.repository_id, rows);
    }
  }

  // Repo port row = mean of its missions' port rows, then spread apart so two
  // repos whose means land close together never overlap.
  const repoRows = repoNodes.map((repo, index) => {
    const rows = repoPortRows.get(repo.id);
    const row =
      rows && rows.length > 0
        ? rows.reduce((sum, value) => sum + value, 0) / rows.length
        : index * (REPO_HEIGHT + LANE_GAP) + REPO_PORT_Y;
    return { id: repo.id, row };
  });
  repoRows.sort((a, b) => a.row - b.row);
  const minRepoSeparation = REPO_HEIGHT + LANE_GAP;
  for (let index = 1; index < repoRows.length; index++) {
    const previous = repoRows[index - 1];
    const current = repoRows[index];
    if (current.row - previous.row < minRepoSeparation) {
      current.row = previous.row + minRepoSeparation;
    }
  }
  repoRows.forEach(({ id, row }) => {
    tops[id] = row - REPO_PORT_Y;
  });

  const positions: Record<string, NodePosition> = {};
  for (const node of nodes) {
    positions[node.id] = { x: columnOf(node.id) * COL_STEP, y: tops[node.id] ?? 0 };
  }
  return positions;
}
