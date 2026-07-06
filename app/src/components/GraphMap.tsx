import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodes,
  useNodesState,
  ViewportPortal,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot,
  Boxes,
  Check,
  ClipboardList,
  FolderGit2,
  GitPullRequest,
  Loader,
  Play,
  Plus,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { layoutGraph, type NodePosition } from "../graphLayout";
import { type GraphNodeKind, type GraphNodeMeta, type MissionNodeStatus, type WorkspaceGraphEdge, type WorkspaceGraphNode } from "../graph";

type GraphNode = WorkspaceGraphNode & { status?: MissionNodeStatus };

// Actions a node card can fire. All are mission-scoped: the card is the
// operating surface, the callbacks land in App's existing mission plumbing.
export type NodeActions = {
  onRunTask: (missionId: string) => void;
  onApprove: (missionId: string) => void;
  onReject: (missionId: string) => void;
  onVerify: (missionId: string) => void;
  // Draft task card: turn the typed prompt into a real mission (optionally
  // launching it immediately), or discard the draft.
  onCreateTask: (text: string, run: boolean, kind: "task" | "tool") => void;
  onCancelDraft: () => void;
  // Task chains: a drawn task→task edge makes the downstream task wait for the
  // upstream patch to land; deleting the edge dissolves the dependency.
  onLinkTasks: (fromMissionId: string, toMissionId: string) => void;
  onUnlinkTasks: (fromMissionId: string, toMissionId: string) => void;
};

type OrbitalNodeData = {
  kind: GraphNodeKind;
  label: string;
  detail: string;
  status?: MissionNodeStatus;
  missionId?: string;
  meta?: GraphNodeMeta;
  actions: NodeActions;
};

// Fallback node footprint for the lane bounding box before React Flow has
// measured the real DOM nodes. Matches graphLayout's spacing constants.
const NODE_WIDTH = 236;
const NODE_HEIGHT = 118;
const LANE_PAD_X = 26;
const LANE_PAD_Y = 22;

type GraphMapProps = {
  nodes: GraphNode[];
  edges: WorkspaceGraphEdge[];
  selectedNodeId: string;
  selectedMissionId: string;
  runningMissionIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
  actions: NodeActions;
  // "+ Task" affordance: opens a draft task card on the canvas. Disabled until
  // a repository is connected to own the new task.
  onAddTask: () => void;
  canAddTask: boolean;
};

const EDGE_COLOR: Record<string, string> = {
  runs: "#d9a441",
  proposes: "#5b8bff",
  verifies: "#5b8bff",
  spawns: "#5b8bff",
  coordinates: "#b07cff",
  blocks: "#e2615f",
  then: "#4fbf7b",
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

export function GraphMap({ nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds, onSelectNode, actions, onAddTask, canAddTask }: GraphMapProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<OrbitalNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Only nodes the user explicitly dragged are pinned here. Everything else is
  // re-laid-out fresh on every topology change, so adding a repo never collides
  // with an existing one's stale coordinates.
  const manualPositionsRef = useRef<Record<string, NodePosition>>({});
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  // Stable action proxy so node data doesn't hold stale App closures — cards
  // always call through to the latest handlers.
  const stableActions = useMemo<NodeActions>(
    () => ({
      onRunTask: (id) => actionsRef.current.onRunTask(id),
      onApprove: (id) => actionsRef.current.onApprove(id),
      onReject: (id) => actionsRef.current.onReject(id),
      onVerify: (id) => actionsRef.current.onVerify(id),
      onCreateTask: (text, run, kind) => actionsRef.current.onCreateTask(text, run, kind),
      onCancelDraft: () => actionsRef.current.onCancelDraft(),
      onLinkTasks: (from, to) => actionsRef.current.onLinkTasks(from, to),
      onUnlinkTasks: (from, to) => actionsRef.current.onUnlinkTasks(from, to),
    }),
    [],
  );

  // Node kinds by id, for validating hand-drawn connections: only task→task
  // edges mean anything, so only those are allowed to form.
  const kindByNodeRef = useRef<Record<string, GraphNodeKind>>({});
  kindByNodeRef.current = Object.fromEntries(nodes.map((node) => [node.id, node.kind]));

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    const { source, target } = connection;
    const chainable = (id: string | null | undefined) => {
      const kind = id ? kindByNodeRef.current[id] : undefined;
      return kind === "task" || kind === "tool";
    };
    return Boolean(source && target && source !== target && chainable(source) && chainable(target));
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      stableActions.onLinkTasks(connection.source, connection.target);
    },
    [stableActions],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      deleted.forEach((edge) => {
        if ((edge.data as { kind?: string } | undefined)?.kind === "then") {
          stableActions.onUnlinkTasks(edge.source, edge.target);
        }
      });
    },
    [stableActions],
  );

  const missionByNode = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    nodes.forEach((node) => {
      map[node.id] = node.mission_id;
    });
    return map;
  }, [nodes]);

  const toData = useCallback(
    (node: GraphNode): OrbitalNodeData => ({
      kind: node.kind,
      label: node.label,
      detail: node.detail,
      status: node.status,
      missionId: node.mission_id,
      meta: node.meta,
      actions: stableActions,
    }),
    [stableActions],
  );

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
        data: toData(node),
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
          data: toData(source),
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
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        isValidConnection={isValidConnection}
        // Forgiving connecting: releasing anywhere near a task card's handle
        // snaps the chain edge onto it.
        connectionRadius={48}
        connectionLineStyle={{ stroke: "#4fbf7b", strokeWidth: 2 }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        nodesConnectable
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
        {/* Top-left: the right side of the window belongs to the task inspector,
            which would cover (and swallow clicks meant for) anything placed there. */}
        <Panel position="top-left" className="canvas-actions">
          <button
            type="button"
            className="canvas-add-task"
            onClick={onAddTask}
            disabled={!canAddTask}
            title={canAddTask ? "Add a task node" : "Connect a repository first"}
          >
            <Plus size={14} aria-hidden="true" />
            Task
          </button>
        </Panel>
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

  // Hand-drawn chain edges stay interactive so they can be selected and
  // deleted (= unlink); generated pipeline edges are wallpaper.
  const isChain = edge.kind === "then";

  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    animated: active,
    data: { kind: edge.kind },
    deletable: isChain,
    focusable: isChain,
    selectable: isChain,
    style: { stroke: color, strokeWidth: selected || isChain ? 2 : 1.4, strokeDasharray: edgeDash(edge.kind) },
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

const KIND_LABEL: Record<GraphNodeKind, string> = {
  repo: "Repository",
  task: "Task",
  agent: "Agent",
  changes: "Changes",
  verify: "Verify",
  campaign: "Campaign",
  tool: "Tool",
};

function KindGlyph({ kind }: { kind: GraphNodeKind }) {
  switch (kind) {
    case "repo":
      return <FolderGit2 size={14} aria-hidden="true" />;
    case "task":
      return <ClipboardList size={14} aria-hidden="true" />;
    case "agent":
      return <Bot size={14} aria-hidden="true" />;
    case "changes":
      return <GitPullRequest size={14} aria-hidden="true" />;
    case "verify":
      return <ShieldCheck size={14} aria-hidden="true" />;
    case "campaign":
      return <Boxes size={14} aria-hidden="true" />;
    case "tool":
      return <Terminal size={14} aria-hidden="true" />;
  }
}

// One operable card per pipeline step. The header names the function, the body
// shows its live state, the footer holds the action that step affords: Run on
// a task, Approve/Reject on changes, Verify on the ship gate.
function OrbitalNode({ data, selected }: NodeProps) {
  const node = data as OrbitalNodeData;
  const live = node.meta?.live ?? false;

  if (node.kind === "task" && node.meta?.draft) {
    return <DraftTaskNode node={node} selected={selected ?? false} />;
  }

  // Only task and tool cards accept hand-drawn connections: a chain edge
  // starts the downstream step when the upstream lands.
  const connectable = node.kind === "task" || node.kind === "tool";

  return (
    <div className={`node-card ${node.kind} ${node.status ?? ""} ${selected ? "selected" : ""} ${live ? "live" : ""}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={connectable} />
      <div className="node-card-head">
        <span className={`node-card-icon ${node.kind}`}>
          <KindGlyph kind={node.kind} />
        </span>
        <span className="node-card-kind">{KIND_LABEL[node.kind]}</span>
        {live ? (
          <Loader size={12} className="spin node-card-live" aria-hidden="true" />
        ) : (
          <span className={`node-status-dot ${node.status ?? ""}`} aria-hidden="true" />
        )}
      </div>
      <div className="node-card-title" title={node.meta?.prompt ?? node.label}>{node.label}</div>
      <NodeBody node={node} />
      <NodeFooter node={node} />
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={connectable} />
    </div>
  );
}

// DraftTaskNode is a task card in authoring mode: the prompt is typed straight
// into the node, then Queue adds it to the backlog and Run launches it at once.
// The draft's text and kind stay local to the card so neither typing nor
// flipping the Task/Tool switch re-renders the graph. On the Tool side the
// same field holds a shell command instead of a prompt.
function DraftTaskNode({ node, selected }: { node: OrbitalNodeData; selected: boolean }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"task" | "tool">("task");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (run: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    node.actions.onCreateTask(trimmed, run, kind);
  };

  const pickKind = (next: "task" | "tool") => {
    setKind(next);
    inputRef.current?.focus();
  };

  return (
    <div className={`node-card ${kind} draft ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <div className="node-card-head">
        <span className={`node-card-icon ${kind}`}>
          {kind === "tool" ? <Terminal size={14} aria-hidden="true" /> : <ClipboardList size={14} aria-hidden="true" />}
        </span>
        <div className="node-draft-kind nodrag" role="tablist" aria-label="Node type">
          <button
            type="button"
            role="tab"
            aria-selected={kind === "task"}
            className={`node-draft-kind-option ${kind === "task" ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              pickKind("task");
            }}
          >
            Task
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={kind === "tool"}
            className={`node-draft-kind-option ${kind === "tool" ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              pickKind("tool");
            }}
          >
            Tool
          </button>
        </div>
        <button
          type="button"
          className="node-draft-close nodrag"
          title="Discard draft"
          onClick={(event) => {
            event.stopPropagation();
            node.actions.onCancelDraft();
          }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <textarea
        ref={inputRef}
        className={`node-draft-input nodrag nowheel ${kind === "tool" ? "mono" : ""}`}
        placeholder={kind === "tool" ? "Command to run (sh -c in the repo)" : "What should get done?"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") node.actions.onCancelDraft();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit(true);
          }
        }}
      />
      <div className="node-card-body">
        {kind === "task" && node.meta?.worker ? <span className="node-tag">{node.meta.worker}</span> : null}
      </div>
      <div className="node-card-actions">
        <button
          type="button"
          className="node-btn nodrag"
          onClick={(event) => {
            event.stopPropagation();
            submit(false);
          }}
        >
          Queue
        </button>
        <button
          type="button"
          className="node-btn primary nodrag"
          title="Create and launch (⌘↵)"
          onClick={(event) => {
            event.stopPropagation();
            submit(true);
          }}
        >
          <Play size={12} aria-hidden="true" />
          Run
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={false} />
    </div>
  );
}

function NodeBody({ node }: { node: OrbitalNodeData }) {
  const meta = node.meta;

  if (node.kind === "task") {
    return (
      <div className="node-card-body">
        <p className="node-card-prompt">{meta?.prompt ?? node.detail}</p>
        {meta?.waitingFor ? <span className="node-tag wait">after: {meta.waitingFor}</span> : null}
        {meta?.worker ? <span className="node-tag">{meta.worker}</span> : null}
      </div>
    );
  }

  if (node.kind === "agent") {
    return (
      <div className="node-card-body">
        <p className={`node-card-now ${meta?.live ? "live" : ""}`}>
          {meta?.now ?? (meta?.live ? "working…" : "idle — open the chat to steer")}
        </p>
      </div>
    );
  }

  if (node.kind === "changes") {
    const files = meta?.files ?? 0;
    return (
      <div className="node-card-body">
        {files > 0 ? (
          <div className="node-card-stats">
            <span>
              {files} file{files === 1 ? "" : "s"}
            </span>
            {meta?.additions ? <span className="add">+{meta.additions}</span> : null}
            {meta?.deletions ? <span className="del">−{meta.deletions}</span> : null}
          </div>
        ) : (
          <p className="node-card-prompt">No change set yet.</p>
        )}
        {meta?.patchState === "approved" ? <span className="node-tag ok">approved</span> : null}
        {meta?.patchState === "rejected" ? <span className="node-tag bad">rejected</span> : null}
      </div>
    );
  }

  if (node.kind === "verify" || node.kind === "tool") {
    return (
      <div className="node-card-body">
        {meta?.command ? <code className="node-card-command">{meta.command}</code> : null}
        {meta?.waitingFor ? <span className="node-tag wait">after: {meta.waitingFor}</span> : null}
        {meta?.verifyState === "passed" ? <span className="node-tag ok">passed</span> : null}
        {meta?.verifyState === "failed" ? <span className="node-tag bad">failed</span> : null}
      </div>
    );
  }

  return (
    <div className="node-card-body">
      <p className="node-card-prompt">{node.detail}</p>
    </div>
  );
}

function NodeFooter({ node }: { node: OrbitalNodeData }) {
  const missionId = node.missionId;
  if (!missionId) return null;
  const meta = node.meta;
  const act = node.actions;

  // Interactive controls carry `nodrag` so React Flow lets the click through
  // instead of starting a card drag. On a failed tool the button is a re-run.
  if ((node.kind === "task" || node.kind === "tool") && meta?.launchable) {
    return (
      <div className="node-card-actions">
        <button
          type="button"
          className="node-btn primary nodrag"
          onClick={(event) => {
            event.stopPropagation();
            act.onRunTask(missionId);
          }}
        >
          <Play size={12} aria-hidden="true" />
          Run
        </button>
      </div>
    );
  }

  if (node.kind === "changes" && meta?.patchState === "pending" && (meta?.files ?? 0) > 0) {
    return (
      <div className="node-card-actions">
        <button
          type="button"
          className="node-btn nodrag"
          onClick={(event) => {
            event.stopPropagation();
            act.onReject(missionId);
          }}
        >
          <X size={12} aria-hidden="true" />
          Reject
        </button>
        <button
          type="button"
          className="node-btn primary nodrag"
          onClick={(event) => {
            event.stopPropagation();
            act.onApprove(missionId);
          }}
        >
          <Check size={12} aria-hidden="true" />
          Approve
        </button>
      </div>
    );
  }

  if (node.kind === "verify" && meta?.verifyState === "ready") {
    return (
      <div className="node-card-actions">
        <button
          type="button"
          className="node-btn primary nodrag"
          onClick={(event) => {
            event.stopPropagation();
            act.onVerify(missionId);
          }}
        >
          <ShieldCheck size={12} aria-hidden="true" />
          Verify
        </button>
      </div>
    );
  }

  return null;
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
        if (data.kind === "task" || data.kind === "tool" || data.kind === "campaign") label = data.label;
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
