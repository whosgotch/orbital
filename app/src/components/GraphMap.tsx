import { FileCode2, Network, RadioTower, ShieldCheck, Zap } from "lucide-react";
import {
  mockGraphEdges,
  type GraphNodeKind,
  type MissionNodeStatus,
  type WorkspaceGraphNode,
} from "../mockMission";

type GraphMapProps = {
  nodes: Array<WorkspaceGraphNode & { status?: MissionNodeStatus }>;
  selectedMissionId: string;
  onSelectMission: (missionId: string) => void;
};

export function GraphMap({ nodes, selectedMissionId, onSelectMission }: GraphMapProps) {
  return (
    <section className="space-map" aria-label="Workspace graph map">
      <div className="starfield" aria-hidden="true" />
      <div className="scanline" aria-hidden="true" />
      <svg className="graph-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {mockGraphEdges.map((edge) => (
          <GraphEdge key={edge.id} edge={edge} nodes={nodes} selectedMissionId={selectedMissionId} />
        ))}
      </svg>
      {nodes.map((node) => (
        <GraphNodeButton
          key={node.id}
          node={node}
          selectedMissionId={selectedMissionId}
          onSelectMission={onSelectMission}
        />
      ))}
    </section>
  );
}

function GraphEdge({
  edge,
  nodes,
  selectedMissionId,
}: {
  edge: (typeof mockGraphEdges)[number];
  nodes: Array<WorkspaceGraphNode & { status?: MissionNodeStatus }>;
  selectedMissionId: string;
}) {
  const from = nodes.find((node) => node.id === edge.from);
  const to = nodes.find((node) => node.id === edge.to);
  if (!from || !to) {
    return null;
  }

  const selected = from.mission_id === selectedMissionId || to.mission_id === selectedMissionId;

  return (
    <line
      className={`graph-edge ${edge.kind} ${selected ? "selected" : ""}`}
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
    />
  );
}

function GraphNodeButton({
  node,
  selectedMissionId,
  onSelectMission,
}: {
  node: WorkspaceGraphNode & { status?: MissionNodeStatus };
  selectedMissionId: string;
  onSelectMission: (missionId: string) => void;
}) {
  const missionSelected = node.mission_id === selectedMissionId;
  const selectable = Boolean(node.mission_id);

  return (
    <button
      className={`graph-node ${node.kind} ${node.status ?? ""} ${missionSelected ? "selected" : ""}`}
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
      type="button"
      disabled={!selectable}
      onClick={() => {
        if (node.mission_id) {
          onSelectMission(node.mission_id);
        }
      }}
    >
      <GraphGlyph kind={node.kind} status={node.status} />
      <span>{node.label}</span>
      <small>{node.detail}</small>
    </button>
  );
}

function GraphGlyph({ kind, status }: { kind: GraphNodeKind; status?: MissionNodeStatus }) {
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

  const Icon = status === "verified" ? ShieldCheck : status === "review" || status === "approved" ? Zap : RadioTower;
  return <Icon size={17} aria-hidden="true" />;
}
