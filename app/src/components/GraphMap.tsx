import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodes,
  useNodesState,
  ViewportPortal,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Boxes, Code2, Crown, Eye, FileCode2, Network, RadioTower, ShieldCheck, Zap } from "lucide-react";
import { layoutGraph, type NodePosition } from "../graphLayout";
import { type GraphNodeKind, type MissionNodeStatus, type WorkspaceGraphEdge, type WorkspaceGraphNode } from "../mockMission";

type GraphNode = WorkspaceGraphNode & { status?: MissionNodeStatus };

type OrbitalNodeData = {
  kind: GraphNodeKind;
  label: string;
  detail: string;
  status?: MissionNodeStatus;
  missionId?: string;
};

// Fallback node footprint for the lane bounding box before React Flow has
// measured the real DOM nodes. Matches graphLayout's spacing constants.
const NODE_WIDTH = 150;
const NODE_HEIGHT = 86;
const LANE_PAD_X = 26;
const LANE_PAD_Y = 22;

type GraphMapProps = {
  nodes: GraphNode[];
  edges: WorkspaceGraphEdge[];
  selectedNodeId: string;
  selectedMissionId: string;
  runningMissionIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
};

const EDGE_COLOR: Record<string, string> = {
  runs: "#d9a441",
  proposes: "#5b8bff",
  verifies: "#5b8bff",
  spawns: "#5b8bff",
  coordinates: "#b07cff",
  blocks: "#e2615f",
};
const NEUTRAL_EDGE = "rgba(139, 147, 161, 0.42)";

function edgeColor(kind: string) {
  return EDGE_COLOR[kind] ?? NEUTRAL_EDGE;
}

function edgeDash(kind: string) {
  if (kind === "spawns" || kind === "coordinates") return "4 3";
  if (kind === "blocks") return "5 4";
  return undefined;
}

const nodeTypes = { orbital: OrbitalNode };

export function GraphMap({ nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds, onSelectNode }: GraphMapProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<OrbitalNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Only nodes the user explicitly dragged are pinned here. Everything else is
  // re-laid-out fresh on every topology change, so adding a repo never collides
  // with an existing one's stale coordinates.
  const manualPositionsRef = useRef<Record<string, NodePosition>>({});

  const missionByNode = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    nodes.forEach((node) => {
      map[node.id] = node.mission_id;
    });
    return map;
  }, [nodes]);

  // Re-layout only when the graph's structure changes (nodes or edges added /
  // removed). Manual drag positions are preserved across data/status updates.
  const topologyKey = useMemo(
    () => `${nodes.map((n) => n.id).sort().join("|")}::${edges.map((e) => e.id).sort().join("|")}`,
    [nodes, edges],
  );

  useEffect(() => {
    const laidOut = layoutGraph(nodes, edges);
    setRfNodes(
      nodes.map((node) => ({
        id: node.id,
        type: "orbital",
        position: manualPositionsRef.current[node.id] ?? laidOut[node.id],
        data: { kind: node.kind, label: node.label, detail: node.detail, status: node.status, missionId: node.mission_id },
        selected: node.id === selectedNodeId,
      })) as Node<OrbitalNodeData>[],
    );
    setRfEdges(edges.map((edge) => toRfEdge(edge, missionByNode, selectedMissionId, runningMissionIds)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey]);

  // Patch node data (status/labels) and selection without moving nodes.
  useEffect(() => {
    setRfNodes((current) =>
      current.map((rfNode) => {
        const source = nodes.find((node) => node.id === rfNode.id);
        if (!source) return rfNode;
        return {
          ...rfNode,
          data: { kind: source.kind, label: source.label, detail: source.detail, status: source.status, missionId: source.mission_id },
          selected: source.id === selectedNodeId,
        };
      }),
    );
    setRfEdges(edges.map((edge) => toRfEdge(edge, missionByNode, selectedMissionId, runningMissionIds)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds]);

  const onNodeDragStop = useCallback((_event: unknown, node: Node) => {
    manualPositionsRef.current[node.id] = node.position;
  }, []);

  // Persist positions for every node moved as part of a marquee selection, so a
  // dragged project lane keeps its new spot across re-layouts.
  const onSelectionDragStop = useCallback((_event: unknown, draggedNodes: Node[]) => {
    draggedNodes.forEach((node) => {
      manualPositionsRef.current[node.id] = node.position;
    });
  }, []);

  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      onSelectNode(node.id);
    },
    [onSelectNode],
  );

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onSelectionDragStop={onSelectionDragStop}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
        // Finder-style marquee: left-drag the canvas draws a selection box;
        // hold Space (or middle/right mouse) to pan instead. Selected nodes
        // drag together so a whole project lane moves as one.
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        panActivationKeyCode="Space"
        selectNodesOnDrag
      >
        <LaneBands />
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="rgba(139, 147, 161, 0.16)" />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          style={{ width: 168, height: 110 }}
          nodeColor={miniMapColor}
          maskColor="rgba(8, 10, 13, 0.7)"
        />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function toRfEdge(
  edge: WorkspaceGraphEdge,
  missionByNode: Record<string, string | undefined>,
  selectedMissionId: string,
  runningMissionIds: Set<string>,
): Edge {
  const fromMission = missionByNode[edge.from];
  const toMission = missionByNode[edge.to];
  const selected = fromMission === selectedMissionId || toMission === selectedMissionId;
  const active =
    (fromMission != null && runningMissionIds.has(fromMission)) || (toMission != null && runningMissionIds.has(toMission));
  const color = selected ? "#5b8bff" : edgeColor(edge.kind);

  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    animated: active,
    style: { stroke: color, strokeWidth: selected ? 2 : 1.4, strokeDasharray: edgeDash(edge.kind) },
    markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color },
  };
}

function miniMapColor(node: Node) {
  const status = (node.data as OrbitalNodeData)?.status;
  if (status === "running") return "#d9a441";
  if (status === "verified") return "#4fbf7b";
  if (status === "blocked") return "#e2615f";
  return "#39414f";
}

function OrbitalNode({ data, selected }: NodeProps) {
  const node = data as OrbitalNodeData;
  return (
    <div className={`graph-node ${node.kind} ${node.status ?? ""} ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <GraphGlyph kind={node.kind} status={node.status} label={node.label} />
      <span>{node.label}</span>
      <small>{node.detail}</small>
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={false} />
    </div>
  );
}

// LaneBands draws a labeled band behind every mission's nodes, computed from
// their LIVE positions so a band always wraps its project — including after the
// project is marquee-selected and dragged to a new spot. It renders inside a
// ViewportPortal so the bands pan and zoom with the graph.
function LaneBands() {
  const nodes = useNodes();
  const lanes = useMemo(() => {
    const groups = new Map<string, Node[]>();
    nodes.forEach((node) => {
      const missionId = (node.data as OrbitalNodeData)?.missionId;
      if (!missionId) return;
      if (!groups.has(missionId)) groups.set(missionId, []);
      groups.get(missionId)!.push(node);
    });

    const result: { missionId: string; label: string; x: number; y: number; width: number; height: number }[] = [];
    groups.forEach((group, missionId) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let label = "";
      group.forEach((node) => {
        const width = node.measured?.width ?? NODE_WIDTH;
        const height = node.measured?.height ?? NODE_HEIGHT;
        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + width);
        maxY = Math.max(maxY, node.position.y + height);
        const data = node.data as OrbitalNodeData;
        if (data.kind === "mission" || data.kind === "campaign") label = data.label;
      });
      result.push({
        missionId,
        label,
        x: minX - LANE_PAD_X,
        y: minY - LANE_PAD_Y,
        width: maxX - minX + LANE_PAD_X * 2,
        height: maxY - minY + LANE_PAD_Y * 2,
      });
    });
    return result;
  }, [nodes]);

  return (
    <ViewportPortal>
      {lanes.map((lane) => (
        <div
          key={lane.missionId}
          className="graph-lane"
          style={{
            position: "absolute",
            transform: `translate(${lane.x}px, ${lane.y}px)`,
            width: lane.width,
            height: lane.height,
          }}
        >
          <span className="graph-lane-label">{lane.label}</span>
        </div>
      ))}
    </ViewportPortal>
  );
}

function GraphGlyph({ kind, status, label }: { kind: GraphNodeKind; status?: MissionNodeStatus; label?: string }) {
  if (kind === "campaign") {
    return <Boxes size={18} aria-hidden="true" />;
  }
  if (kind === "repo") {
    return <Network size={18} aria-hidden="true" />;
  }
  if (kind === "file") {
    return <FileCode2 size={17} aria-hidden="true" />;
  }
  if (kind === "patch") {
    return <Zap size={17} aria-hidden="true" />;
  }
  if (kind === "verification" || kind === "test") {
    return <ShieldCheck size={17} aria-hidden="true" />;
  }
  if (kind === "worker") {
    const lc = label?.toLowerCase() ?? "";
    if (lc.includes("manager")) return <Crown size={17} aria-hidden="true" />;
    if (lc.includes("engineer") || lc.includes("code")) return <Code2 size={17} aria-hidden="true" />;
    if (lc.includes("qa") || lc.includes("quality")) return <ShieldCheck size={17} aria-hidden="true" />;
    if (lc.includes("reviewer") || lc.includes("review")) return <Eye size={17} aria-hidden="true" />;
  }

  const Icon = status === "verified" ? ShieldCheck : status === "review" || status === "approved" ? Zap : RadioTower;
  return <Icon size={17} aria-hidden="true" />;
}
