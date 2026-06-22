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
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Code2, Crown, Eye, FileCode2, Network, RadioTower, ShieldCheck, Zap } from "lucide-react";
import { layoutGraph, type NodePosition } from "../graphLayout";
import { type GraphNodeKind, type MissionNodeStatus, type WorkspaceGraphEdge, type WorkspaceGraphNode } from "../mockMission";

type GraphNode = WorkspaceGraphNode & { status?: MissionNodeStatus };

type OrbitalNodeData = {
  kind: GraphNodeKind;
  label: string;
  detail: string;
  status?: MissionNodeStatus;
};

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
  blocks: "#e2615f",
};
const NEUTRAL_EDGE = "rgba(139, 147, 161, 0.42)";

function edgeColor(kind: string) {
  return EDGE_COLOR[kind] ?? NEUTRAL_EDGE;
}

function edgeDash(kind: string) {
  if (kind === "spawns") return "4 3";
  if (kind === "blocks") return "5 4";
  return undefined;
}

const nodeTypes = { orbital: OrbitalNode };

export function GraphMap({ nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds, onSelectNode }: GraphMapProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<OrbitalNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const positionsRef = useRef<Record<string, NodePosition>>({});

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
    const merged: Record<string, NodePosition> = {};
    nodes.forEach((node) => {
      merged[node.id] = positionsRef.current[node.id] ?? laidOut[node.id];
    });
    positionsRef.current = merged;

    setRfNodes(
      nodes.map((node) => ({
        id: node.id,
        type: "orbital",
        position: merged[node.id],
        data: { kind: node.kind, label: node.label, detail: node.detail, status: node.status },
        selected: node.id === selectedNodeId,
      })),
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
          data: { kind: source.kind, label: source.label, detail: source.detail, status: source.status },
          selected: source.id === selectedNodeId,
        };
      }),
    );
    setRfEdges(edges.map((edge) => toRfEdge(edge, missionByNode, selectedMissionId, runningMissionIds)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds]);

  const onNodeDragStop = useCallback((_event: unknown, node: Node) => {
    positionsRef.current[node.id] = node.position;
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
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
      >
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

function GraphGlyph({ kind, status, label }: { kind: GraphNodeKind; status?: MissionNodeStatus; label?: string }) {
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
