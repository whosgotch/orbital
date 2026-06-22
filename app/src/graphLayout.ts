import dagre from "@dagrejs/dagre";
import type { WorkspaceGraphEdge, WorkspaceGraphNode } from "./mockMission";

export type NodePosition = { x: number; y: number };

// Dagre is fed a single uniform node footprint. Mixing per-kind sizes makes its
// rank assignment collapse multiple ranks onto the same coordinate, so layout
// uses one size for spacing while the rendered nodes keep their real CSS sizes.
const NODE_WIDTH = 150;
const NODE_HEIGHT = 86;

// layoutGraph runs a left-to-right dagre pass and returns top-left positions
// keyed by node id (React Flow positions nodes by their top-left corner).
export function layoutGraph(
  nodes: WorkspaceGraphNode[],
  edges: WorkspaceGraphEdge[],
): Record<string, NodePosition> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 96 });
  graph.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(nodes.map((node) => node.id));
  nodes.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => {
    if (ids.has(edge.from) && ids.has(edge.to)) {
      graph.setEdge(edge.from, edge.to);
    }
  });

  dagre.layout(graph);

  const positions: Record<string, NodePosition> = {};
  nodes.forEach((node) => {
    const laid = graph.node(node.id);
    positions[node.id] = { x: laid.x - NODE_WIDTH / 2, y: laid.y - NODE_HEIGHT / 2 };
  });
  return positions;
}
