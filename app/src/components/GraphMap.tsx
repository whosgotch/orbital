import { Code2, Crown, Eye, FileCode2, Network, RadioTower, ShieldCheck, Zap } from "lucide-react";
import {
  type GraphNodeKind,
  type MissionNodeStatus,
  type WorkspaceGraphEdge,
  type WorkspaceGraphNode,
} from "../mockMission";

type GraphMapProps = {
  nodes: Array<WorkspaceGraphNode & { status?: MissionNodeStatus }>;
  edges: WorkspaceGraphEdge[];
  selectedNodeId: string;
  selectedMissionId: string;
  runningMissionIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
};

export function GraphMap({ nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds, onSelectNode }: GraphMapProps) {
  return (
    <section className="space-map" aria-label="Workspace graph map">
      <div className="starfield" aria-hidden="true" />
      <div className="scanline" aria-hidden="true" />
      <div className="factory-lanes" aria-hidden="true">
        <span>Source</span>
        <span>Intake</span>
        <span>Manager</span>
        <span>Workers</span>
        <span>Patch</span>
        <span>QA</span>
      </div>
      <svg className="graph-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id="edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        {edges.map((edge) => (
          <GraphEdge key={edge.id} edge={edge} nodes={nodes} selectedMissionId={selectedMissionId} runningMissionIds={runningMissionIds} />
        ))}
      </svg>
      {nodes.map((node) => (
        <GraphNodeButton
          key={node.id}
          node={node}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
        />
      ))}
    </section>
  );
}

function GraphEdge({
  edge,
  nodes,
  selectedMissionId,
  runningMissionIds,
}: {
  edge: WorkspaceGraphEdge;
  nodes: Array<WorkspaceGraphNode & { status?: MissionNodeStatus }>;
  selectedMissionId: string;
  runningMissionIds: Set<string>;
}) {
  const path = edgePath(edge, nodes);
  if (!path) {
    return null;
  }

  const selected = edgeTouchesMission(edge, nodes, selectedMissionId);
  const active = edgeTouchesRunningMission(edge, nodes, runningMissionIds);

  return <path className={`graph-edge ${edge.kind} ${selected ? "selected" : ""} ${active ? "active" : ""}`} d={path} markerEnd="url(#edge-arrow)" />;
}

function edgePath(edge: WorkspaceGraphEdge, nodes: Array<WorkspaceGraphNode & { status?: MissionNodeStatus }>) {
  const from = nodes.find((node) => node.id === edge.from);
  const to = nodes.find((node) => node.id === edge.to);
  if (!from || !to) {
    return "";
  }

  const midX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
}

function edgeTouchesMission(
  edge: WorkspaceGraphEdge,
  nodes: Array<WorkspaceGraphNode & { status?: MissionNodeStatus }>,
  selectedMissionId: string,
) {
  const from = nodes.find((node) => node.id === edge.from);
  const to = nodes.find((node) => node.id === edge.to);
  return from?.mission_id === selectedMissionId || to?.mission_id === selectedMissionId;
}

function edgeTouchesRunningMission(
  edge: WorkspaceGraphEdge,
  nodes: Array<WorkspaceGraphNode & { status?: MissionNodeStatus }>,
  runningMissionIds: Set<string>,
) {
  const from = nodes.find((node) => node.id === edge.from);
  const to = nodes.find((node) => node.id === edge.to);
  return (
    (from?.mission_id != null && runningMissionIds.has(from.mission_id)) ||
    (to?.mission_id != null && runningMissionIds.has(to.mission_id))
  );
}

function GraphNodeButton({
  node,
  selectedNodeId,
  onSelectNode,
}: {
  node: WorkspaceGraphNode & { status?: MissionNodeStatus };
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
}) {
  const selected = node.id === selectedNodeId;

  return (
    <button
      className={`graph-node ${node.kind} ${node.status ?? ""} ${selected ? "selected" : ""}`}
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
      type="button"
      onClick={() => onSelectNode(node.id)}
    >
      <GraphGlyph kind={node.kind} status={node.status} label={node.label} />
      <span>{node.label}</span>
      <small>{node.detail}</small>
    </button>
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
