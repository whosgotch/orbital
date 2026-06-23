import dagre from "@dagrejs/dagre";
import type { WorkspaceGraphEdge, WorkspaceGraphNode } from "./mockMission";

export type NodePosition = { x: number; y: number };

// Dagre is fed a single uniform node footprint. Mixing per-kind sizes makes its
// rank assignment collapse multiple ranks onto the same coordinate, so layout
// uses one size for spacing while the rendered nodes keep their real CSS sizes.
const NODE_WIDTH = 150;
const NODE_HEIGHT = 86;
const COL_GAP = 96; // horizontal gap between pipeline stages within a lane
const ROW_GAP = 34; // vertical gap between branches inside one lane
const LANE_GAP = 60; // vertical gap between mission lanes
const REPO_COL = NODE_WIDTH + COL_GAP; // x of the mission column (repo sits left of it)

// layoutGraph arranges the graph as swimlanes: every mission is its own lane,
// laid out left-to-right with dagre, and the lanes are stacked vertically and
// grouped by repository. The repository node anchors the left of its lanes.
// This keeps a large, fully-expanded multi-mission workflow legible instead of
// letting one global dagre pass scatter the nodes. Returns top-left positions
// keyed by node id (React Flow positions nodes by their top-left corner).
export function layoutGraph(
  nodes: WorkspaceGraphNode[],
  edges: WorkspaceGraphEdge[],
): Record<string, NodePosition> {
  const centers: Record<string, NodePosition> = {};

  const repoNodes = nodes.filter((node) => node.kind === "repo");

  // Bucket every non-repo node into its mission's lane.
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

  // Keep a repository's missions adjacent, so lanes read as grouped clusters.
  const repoOfLane = (missionId: string) => laneNodes.get(missionId)?.[0]?.repository_id ?? "";
  laneOrder.sort((a, b) => {
    const ra = repoOfLane(a);
    const rb = repoOfLane(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a < b ? -1 : 1;
  });

  const repoMissionYs = new Map<string, number[]>();
  let laneTop = 0;

  for (const missionId of laneOrder) {
    const lane = laneNodes.get(missionId)!;
    const laneSet = new Set(lane.map((node) => node.id));

    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "LR", nodesep: ROW_GAP, ranksep: COL_GAP, marginx: 0, marginy: 0 });
    graph.setDefaultEdgeLabel(() => ({}));
    lane.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
    edges.forEach((edge) => {
      if (laneSet.has(edge.from) && laneSet.has(edge.to)) graph.setEdge(edge.from, edge.to);
    });
    dagre.layout(graph);

    let minX = Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    lane.forEach((node) => {
      const laid = graph.node(node.id);
      minX = Math.min(minX, laid.x);
      minY = Math.min(minY, laid.y);
      maxY = Math.max(maxY, laid.y);
    });

    // Place this lane: its leftmost stage sits at the mission column, and the
    // whole lane drops into the next vertical band.
    const laneCenterTop = laneTop + NODE_HEIGHT / 2;
    lane.forEach((node) => {
      const laid = graph.node(node.id);
      centers[node.id] = {
        x: REPO_COL + (laid.x - minX),
        y: laneCenterTop + (laid.y - minY),
      };
    });

    const missionNode = lane.find((node) => node.kind === "mission");
    if (missionNode?.repository_id) {
      const ys = repoMissionYs.get(missionNode.repository_id) ?? [];
      ys.push(centers[missionNode.id].y);
      repoMissionYs.set(missionNode.repository_id, ys);
    }

    laneTop += maxY - minY + NODE_HEIGHT + LANE_GAP;
  }

  // Anchor each repository node to the left, vertically centered on its lanes.
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
