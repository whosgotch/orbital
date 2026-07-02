import dagre from "@dagrejs/dagre";
import type { WorkspaceGraphEdge, WorkspaceGraphNode } from "./graph";

export type NodePosition = { x: number; y: number };

// Dagre is fed a single uniform node footprint. Mixing per-kind sizes makes its
// rank assignment collapse multiple ranks onto the same coordinate, so layout
// uses one size for spacing while the rendered nodes keep their real CSS sizes.
const NODE_WIDTH = 150;
const NODE_HEIGHT = 86;
const COL_GAP = 96; // horizontal gap between pipeline stages
const ROW_GAP = 30; // vertical gap between branches inside one lane
const LANE_GAP = 52; // vertical gap between mission lanes
const COL_STEP = NODE_WIDTH + COL_GAP; // distance between aligned columns

// layoutGraph arranges the graph as aligned swimlanes: every mission is its own
// lane, and each node snaps to a GLOBAL column (its longest-path depth from the
// repo) so the same pipeline stage lines up vertically across every lane — a
// crisp grid for a large multi-mission workflow. Vertical placement within a
// lane still comes from a dagre pass, which keeps branches (files, parallel
// agents) tidy. Returns top-left positions keyed by node id.
export function layoutGraph(nodes: WorkspaceGraphNode[], edges: WorkspaceGraphEdge[]): Record<string, NodePosition> {
  const present = new Set(nodes.map((node) => node.id));
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

  // Bucket non-repo nodes into mission lanes, keeping a repo's missions adjacent.
  const laneOrder: string[] = [];
  const laneNodes = new Map<string, WorkspaceGraphNode[]>();
  for (const node of nodes) {
    if (node.kind === "repo" || !node.mission_id) continue;
    if (!laneNodes.has(node.mission_id)) {
      laneNodes.set(node.mission_id, []);
      laneOrder.push(node.mission_id);
    }
    laneNodes.get(node.mission_id)!.push(node);
  }
  const repoOfLane = (missionId: string) => laneNodes.get(missionId)?.[0]?.repository_id ?? "";
  laneOrder.sort((a, b) => {
    const ra = repoOfLane(a);
    const rb = repoOfLane(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a < b ? -1 : 1;
  });

  const centers: Record<string, NodePosition> = {};
  const repoMissionYs = new Map<string, number[]>();
  let laneTop = 0;

  for (const missionId of laneOrder) {
    const lane = laneNodes.get(missionId)!;
    const laneSet = new Set(lane.map((node) => node.id));

    // Dagre gives the vertical arrangement; we ignore its x and use columns.
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: COL_GAP, marginx: 0, marginy: 0 });
    graph.setDefaultEdgeLabel(() => ({}));
    lane.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
    edges.forEach((edge) => {
      if (laneSet.has(edge.from) && laneSet.has(edge.to)) graph.setEdge(edge.from, edge.to);
    });
    dagre.layout(graph);

    let minY = Infinity;
    let maxY = -Infinity;
    lane.forEach((node) => {
      const laid = graph.node(node.id);
      minY = Math.min(minY, laid.y);
      maxY = Math.max(maxY, laid.y);
    });

    const laneCenterTop = laneTop + NODE_HEIGHT / 2;
    lane.forEach((node) => {
      const laid = graph.node(node.id);
      centers[node.id] = {
        x: columnOf(node.id) * COL_STEP + NODE_WIDTH / 2,
        y: laneCenterTop + (laid.y - minY),
      };
    });

    const missionNode = lane.find((node) => node.kind === "mission");
    if (missionNode?.repository_id) {
      const ys = repoMissionYs.get(missionNode.repository_id) ?? [];
      ys.push(centers[missionNode.id].y);
      repoMissionYs.set(missionNode.repository_id, ys);
    }

    const laneHeight = maxY - minY + NODE_HEIGHT;
    laneTop += laneHeight + LANE_GAP;
  }

  repoNodes.forEach((repo, index) => {
    const ys = repoMissionYs.get(repo.id);
    const y = ys && ys.length > 0 ? ys.reduce((sum, value) => sum + value, 0) / ys.length : index * (NODE_HEIGHT + LANE_GAP);
    centers[repo.id] = { x: NODE_WIDTH / 2, y };
  });

  const positions: Record<string, NodePosition> = {};
  for (const node of nodes) {
    const center = centers[node.id] ?? { x: 0, y: 0 };
    positions[node.id] = { x: center.x - NODE_WIDTH / 2, y: center.y - NODE_HEIGHT / 2 };
  }
  return positions;
}
