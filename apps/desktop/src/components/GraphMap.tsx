import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Check, GitBranch, GitCommitHorizontal, Loader, Play, ShieldCheck, X } from "lucide-react";
import { layoutGraph, type NodePosition } from "../graphLayout";
import { type GraphNodeKind, type GraphNodeMeta, type MissionNodeStatus, type WorkspaceGraphEdge, type WorkspaceGraphNode } from "../graph";
import { useModels } from "../useModels";

type GraphNode = WorkspaceGraphNode & { status?: MissionNodeStatus };

export type DraftWorker = "claude-engineer" | "local-command";

export type NodeActions = {
  onRunTask: (missionId: string) => void;
  onApprove: (missionId: string) => void;
  onReject: (missionId: string) => void;
  onVerify: (missionId: string) => void;
  // Tools resolve their own execution and ignore the worker param.
  onCreateTask: (text: string, run: boolean, kind: "task" | "tool", worker: DraftWorker, model?: string) => void;
  onCancelDraft: () => void;
  // A drawn task→task edge makes the downstream task wait for the upstream patch to land; deleting the edge dissolves the dependency.
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

type GraphMapProps = {
  nodes: GraphNode[];
  edges: WorkspaceGraphEdge[];
  selectedNodeId: string;
  selectedMissionId: string;
  runningMissionIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
  actions: NodeActions;
};

// Edges stay neutral unless they carry meaning: a chain (then) and a block are the only relationships worth a hue.
const EDGE_COLOR: Record<string, string> = {
  blocks: "#e5615c",
  then: "#3fb96f",
};
const NEUTRAL_EDGE = "rgba(152, 152, 159, 0.42)";

function edgeColor(kind: string) {
  return EDGE_COLOR[kind] ?? NEUTRAL_EDGE;
}

function edgeDash(kind: string) {
  if (kind === "spawns" || kind === "coordinates") return "4 3";
  if (kind === "blocks") return "5 4";
  return undefined;
}

const nodeTypes = { orbital: OrbitalNode };

export function GraphMap({ nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds, onSelectNode, actions }: GraphMapProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<OrbitalNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Only nodes the user explicitly dragged are pinned here; everything else is re-laid-out fresh on every topology change.
  const manualPositionsRef = useRef<Record<string, NodePosition>>({});
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);
  // Stable action proxy so node data doesn't hold stale App closures.
  const stableActions = useMemo<NodeActions>(
    () => ({
      onRunTask: (id) => actionsRef.current.onRunTask(id),
      onApprove: (id) => actionsRef.current.onApprove(id),
      onReject: (id) => actionsRef.current.onReject(id),
      onVerify: (id) => actionsRef.current.onVerify(id),
      onCreateTask: (text, run, kind, worker, model) => actionsRef.current.onCreateTask(text, run, kind, worker, model),
      onCancelDraft: () => actionsRef.current.onCancelDraft(),
      onLinkTasks: (from, to) => actionsRef.current.onLinkTasks(from, to),
      onUnlinkTasks: (from, to) => actionsRef.current.onUnlinkTasks(from, to),
    }),
    [],
  );

  // Delays are pinned per id so re-layouts never replay the settle-in motion.
  const settleDelaysRef = useRef<Record<string, number>>({});

  // Only task→task edges mean anything, so only those are allowed to form.
  const kindByNodeRef = useRef<Record<string, GraphNodeKind>>({});
  useEffect(() => {
    kindByNodeRef.current = Object.fromEntries(nodes.map((node) => [node.id, node.kind]));
  }, [nodes]);

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    const { source, target } = connection;
    const chainable = (id: string | null | undefined) => {
      const kind = id ? kindByNodeRef.current[id] : undefined;
      return kind === "task" || kind === "tool" || kind === "research";
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

  // Re-layout only when the graph's structure changes (nodes or edges added / removed); manual drag positions are preserved across data/status updates.
  const topologyKey = useMemo(
    () => `${nodes.map((n) => n.id).sort().join("|")}::${edges.map((e) => e.id).sort().join("|")}`,
    [nodes, edges],
  );

  useEffect(() => {
    const laidOut = layoutGraph(nodes, edges, manualPositionsRef.current);
    let appearIndex = 0;
    nodes.forEach((node) => {
      if (!(node.id in settleDelaysRef.current)) {
        settleDelaysRef.current[node.id] = Math.min(appearIndex * 45, 315);
        appearIndex += 1;
      }
    });
    setRfNodes(
      nodes.map((node) => ({
        id: node.id,
        type: "orbital",
        position: manualPositionsRef.current[node.id] ?? laidOut[node.id],
        data: toData(node),
        selected: node.id === selectedNodeId,
        style: { "--settle-delay": `${settleDelaysRef.current[node.id]}ms` } as React.CSSProperties,
      })) as Node<OrbitalNodeData>[],
    );
    setRfEdges(edges.map((edge) => toRfEdge(edge, missionByNode, selectedMissionId, runningMissionIds)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey]);

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

  const onPaneClick = useCallback(() => onSelectNode(""), [onSelectNode]);

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
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        isValidConnection={isValidConnection}
        // Releasing anywhere near a task card's handle snaps the chain edge onto it.
        connectionRadius={48}
        connectionLineStyle={{ stroke: "#3fb96f", strokeWidth: 2 }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        nodesConnectable
        edgesFocusable={false}
        // Left-drag draws a selection box; hold Space (or middle/right mouse) to pan instead.
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        panActivationKeyCode="Space"
        selectNodesOnDrag
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="rgba(255, 255, 255, 0.06)" />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          style={{ width: 168, height: 110 }}
          nodeColor={miniMapColor}
          maskColor="rgba(0, 0, 0, 0.7)"
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
  const color = selected ? "#ececee" : edgeColor(edge.kind);

  // Hand-drawn chain edges stay interactive so they can be selected and deleted (= unlink); generated pipeline edges are wallpaper.
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
  if (status === "verified") return "#3fb96f";
  if (status === "blocked") return "#e5615c";
  return "rgba(255, 255, 255, 0.16)";
}

const KIND_LABEL: Record<GraphNodeKind, string> = {
  repo: "Repository",
  task: "Task",
  agent: "Agent",
  changes: "Changes",
  verify: "Verify",
  campaign: "Campaign",
  tool: "Tool",
  research: "Research",
};

function OrbitalNode({ data, selected }: NodeProps) {
  const node = data as OrbitalNodeData;
  const live = node.meta?.live ?? false;

  if (node.kind === "task" && node.meta?.draft) {
    return <DraftTaskNode node={node} selected={selected ?? false} />;
  }

  // Only task, tool, and research cards accept hand-drawn connections: a chain edge starts the downstream step when the upstream lands.
  const connectable = node.kind === "task" || node.kind === "tool" || node.kind === "research";

  return (
    <div className={`node-card ${node.kind} ${node.status ?? ""} ${selected ? "selected" : ""} ${live ? "live" : ""}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={connectable} />
      <div className="node-card-head">
        {live ? (
          <Loader size={11} className="spin node-card-live" aria-hidden="true" />
        ) : (
          <span className={`node-status-dot ${node.status ?? ""}`} aria-hidden="true" />
        )}
        <span className="node-card-kind">{KIND_LABEL[node.kind]}</span>
      </div>
      <div className="node-card-title" title={node.meta?.prompt ?? node.label}>{node.label}</div>
      <NodeBody node={node} />
      <NodeFooter node={node} />
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={connectable} />
    </div>
  );
}

// Draft text/kind stay local to the card so neither typing nor flipping the Task/Tool switch re-renders the graph.
function DraftTaskNode({ node, selected }: { node: OrbitalNodeData; selected: boolean }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"task" | "tool">("task");
  const [worker, setWorker] = useState<DraftWorker>("claude-engineer");
  // Model for this one task; empty follows the global pick.
  const [model, setModel] = useState("");
  const models = useModels();
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
    node.actions.onCreateTask(trimmed, run, kind, worker, model || undefined);
  };

  const pickKind = (next: "task" | "tool") => {
    setKind(next);
    inputRef.current?.focus();
  };

  return (
    <div className={`node-card ${kind} draft ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <div className="node-card-head">
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
        {kind === "task" ? (
          <div className="node-draft-selects">
            <select
              className="node-draft-worker nodrag"
              aria-label="Agent that runs this task"
              title="Agent that runs this task"
              value={worker}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => setWorker(event.target.value as DraftWorker)}
            >
              <option value="claude-engineer">Claude</option>
              <option value="local-command">Local command</option>
            </select>
            <select
              className="node-draft-worker nodrag"
              aria-label="Model for this task"
              title="Model for this task (default follows the sidebar pick)"
              value={model}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id === "" ? "Default model" : option.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
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
        {meta?.attachments ? (
          <span className="node-tag">
            {meta.attachments} image{meta.attachments === 1 ? "" : "s"}
          </span>
        ) : null}
        <CommitChip hash={meta?.commitHash} />
      </div>
    );
  }

  if (node.kind === "research") {
    return (
      <div className="node-card-body">
        <p className="node-card-prompt">{meta?.prompt ?? node.detail}</p>
        {meta?.waitingFor ? <span className="node-tag wait">after: {meta.waitingFor}</span> : null}
        {meta?.attachments ? (
          <span className="node-tag">
            {meta.attachments} image{meta.attachments === 1 ? "" : "s"}
          </span>
        ) : null}
        {node.status === "verified" ? <span className="node-tag ok">findings ready</span> : null}
        <CommitChip hash={meta?.commitHash} />
      </div>
    );
  }

  if (node.kind === "repo") {
    return (
      <div className="node-card-body">
        <p className="node-card-prompt">{node.detail}</p>
        {meta?.branch ? (
          <span className="git-branch-chip">
            <GitBranch size={12} aria-hidden="true" />
            {meta.branch}
          </span>
        ) : null}
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
        {node.kind === "tool" ? <CommitChip hash={meta?.commitHash} /> : null}
      </div>
    );
  }

  return (
    <div className="node-card-body">
      <p className="node-card-prompt">{node.detail}</p>
    </div>
  );
}

function CommitChip({ hash }: { hash?: string }) {
  if (!hash) return null;
  return (
    <span className="git-commit-chip">
      <GitCommitHorizontal size={11} aria-hidden="true" />
      {hash.slice(0, 7)}
    </span>
  );
}

function NodeFooter({ node }: { node: OrbitalNodeData }) {
  const missionId = node.missionId;
  if (!missionId) return null;
  const meta = node.meta;
  const act = node.actions;

  // `nodrag` so React Flow lets the click through instead of starting a card drag. On a failed tool the button is a re-run.
  if ((node.kind === "task" || node.kind === "tool" || node.kind === "research") && meta?.launchable) {
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

