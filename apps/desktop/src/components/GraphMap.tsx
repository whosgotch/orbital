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
import { Check, Loader, Play, ShieldCheck, Sparkles, X } from "lucide-react";
import { layoutGraph, type NodePosition } from "../graphLayout";
import { type GraphNodeKind, type GraphNodeMeta, type MissionNodeStatus, type WorkspaceGraphEdge, type WorkspaceGraphNode } from "../graph";
import type { PlanFeedItem } from "../domain";
import { PlanLiveFeed } from "./PlanLiveFeed";
import { CURATED_MODELS } from "../models";

type GraphNode = WorkspaceGraphNode & { status?: MissionNodeStatus };

// Which agent staffs a drafted task, picked on the draft card.
export type DraftWorker = "claude-engineer" | "mock" | "local-command";

// Actions a node card can fire. All are mission-scoped: the card is the
// operating surface, the callbacks land in App's existing mission plumbing.
export type NodeActions = {
  onRunTask: (missionId: string) => void;
  onApprove: (missionId: string) => void;
  onReject: (missionId: string) => void;
  onVerify: (missionId: string) => void;
  // Draft task card: turn the typed prompt into a real mission (optionally
  // launching it immediately), or discard the draft. The worker is chosen on
  // the card itself; tools resolve their own execution and ignore it.
  onCreateTask: (text: string, run: boolean, kind: "task" | "tool", worker: DraftWorker, model?: string) => void;
  onCancelDraft: () => void;
  // Task chains: a drawn task→task edge makes the downstream task wait for the
  // upstream patch to land; deleting the edge dissolves the dependency.
  onLinkTasks: (fromMissionId: string, toMissionId: string) => void;
  onUnlinkTasks: (fromMissionId: string, toMissionId: string) => void;
  // Plan a typed goal instead of queueing it: the AI reads the repo and fans
  // the goal out into a plan node plus its tasks. The big-task path.
  onPlanGoal: (text: string, model?: string) => void;
};

type OrbitalNodeData = {
  kind: GraphNodeKind;
  label: string;
  detail: string;
  status?: MissionNodeStatus;
  missionId?: string;
  meta?: GraphNodeMeta;
  actions: NodeActions;
  // Set on the draft card while a plan is in flight: the card stays open and
  // shows the AI's streamed thinking instead of its action buttons.
  planning?: boolean;
  planFeed?: PlanFeedItem[];
};


type GraphMapProps = {
  nodes: GraphNode[];
  edges: WorkspaceGraphEdge[];
  selectedNodeId: string;
  selectedMissionId: string;
  runningMissionIds: Set<string>;
  planningActive: boolean;
  planFeed: PlanFeedItem[];
  onSelectNode: (nodeId: string) => void;
  actions: NodeActions;
};

// Edges stay neutral unless they carry meaning: a chain (then) and a block are
// the only relationships worth a hue.
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

export function GraphMap({ nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds, planningActive, planFeed, onSelectNode, actions }: GraphMapProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<OrbitalNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Only nodes the user explicitly dragged are pinned here. Everything else is
  // re-laid-out fresh on every topology change, so adding a repo never collides
  // with an existing one's stale coordinates.
  const manualPositionsRef = useRef<Record<string, NodePosition>>({});
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);
  // Stable action proxy so node data doesn't hold stale App closures — cards
  // always call through to the latest handlers.
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
      onPlanGoal: (text, model) => actionsRef.current.onPlanGoal(text, model),
    }),
    [],
  );

  // Settle-in: each node eases into place once, when it first appears — a batch
  // (opening a repo) settles staggered, a single node spawned mid-run settles
  // immediately. Delays are pinned per id so re-layouts never replay the motion.
  const settleDelaysRef = useRef<Record<string, number>>({});

  // Node kinds by id, for validating hand-drawn connections: only task→task
  // edges mean anything, so only those are allowed to form.
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
      // Only the draft card carries the live plan feed; other nodes stay lean.
      planning: node.meta?.draft ? planningActive : undefined,
      planFeed: node.meta?.draft && planningActive ? planFeed : undefined,
    }),
    [stableActions, planningActive, planFeed],
  );

  // Re-layout only when the graph's structure changes (nodes or edges added /
  // removed). Manual drag positions are preserved across data/status updates.
  const topologyKey = useMemo(
    () => `${nodes.map((n) => n.id).sort().join("|")}::${edges.map((e) => e.id).sort().join("|")}`,
    [nodes, edges],
  );

  useEffect(() => {
    const laidOut = layoutGraph(nodes, edges);
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
  }, [nodes, edges, selectedNodeId, selectedMissionId, runningMissionIds, planningActive, planFeed]);

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

  // Clicking empty canvas clears the selection, which closes the task panel.
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
        // Forgiving connecting: releasing anywhere near a task card's handle
        // snaps the chain edge onto it.
        connectionRadius={48}
        connectionLineStyle={{ stroke: "#3fb96f", strokeWidth: 2 }}
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
  plan: "Plan",
  research: "Research",
};

// One operable card per pipeline step. The header names the function, the body
// shows its live state, the footer holds the action that step affords: Run on
// a task, Approve/Reject on changes, Verify on the ship gate.
function OrbitalNode({ data, selected }: NodeProps) {
  const node = data as OrbitalNodeData;
  const live = node.meta?.live ?? false;

  if (node.kind === "task" && node.meta?.draft) {
    return <DraftTaskNode node={node} selected={selected ?? false} />;
  }

  // Only task, tool, and research cards accept hand-drawn connections: a chain
  // edge starts the downstream step when the upstream lands.
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

// DraftTaskNode is a task card in authoring mode: the prompt is typed straight
// into the node, then Queue adds it to the backlog and Run launches it at once.
// The draft's text and kind stay local to the card so neither typing nor
// flipping the Task/Tool switch re-renders the graph. On the Tool side the
// same field holds a shell command instead of a prompt.
function DraftTaskNode({ node, selected }: { node: OrbitalNodeData; selected: boolean }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"task" | "tool">("task");
  const [worker, setWorker] = useState<DraftWorker>("claude-engineer");
  // Model for this one task/plan; empty follows the global pick.
  const [model, setModel] = useState("");
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
        disabled={node.planning}
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
      {node.planning ? <PlanLiveFeed feed={node.planFeed ?? []} /> : null}
      <div className="node-card-body">
        {kind === "task" ? (
          <div className="node-draft-selects">
            <select
              className="node-draft-worker nodrag"
              aria-label="Agent that runs this task"
              title="Agent that runs this task"
              value={worker}
              disabled={node.planning}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => setWorker(event.target.value as DraftWorker)}
            >
              <option value="claude-engineer">Claude</option>
              <option value="mock">Demo agent</option>
              <option value="local-command">Local command</option>
            </select>
            <select
              className="node-draft-worker nodrag"
              aria-label="Model for this task"
              title="Model for this task (default follows the sidebar pick)"
              value={model}
              disabled={node.planning}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => setModel(event.target.value)}
            >
              {CURATED_MODELS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id === "" ? "Default model" : option.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="node-card-actions">
        {kind === "task" ? (
          <button
            type="button"
            className="node-btn nodrag"
            disabled={node.planning}
            title="Big task? The AI reads the repo, plans it, and creates the tasks"
            onClick={(event) => {
              event.stopPropagation();
              const trimmed = text.trim();
              if (!trimmed) {
                inputRef.current?.focus();
                return;
              }
              node.actions.onPlanGoal(trimmed, model || undefined);
            }}
          >
            {node.planning ? <Loader size={12} className="spin" aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}
            {node.planning ? "Planning…" : "Plan"}
          </button>
        ) : null}
        <button
          type="button"
          className="node-btn nodrag"
          disabled={node.planning}
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
          disabled={node.planning}
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

  if (node.kind === "plan") {
    const tasks = meta?.taskCount ?? 0;
    return (
      <div className="node-card-body">
        <div className="node-card-stats">
          <span>
            {tasks} task{tasks === 1 ? "" : "s"}
          </span>
          {meta?.planFormat ? <span className="node-tag">{meta.planFormat}</span> : null}
        </div>
        <p className="node-card-prompt">Open to read the plan.</p>
      </div>
    );
  }

  if (node.kind === "task") {
    return (
      <div className="node-card-body">
        <p className="node-card-prompt">{meta?.prompt ?? node.detail}</p>
        {meta?.waitingFor ? <span className="node-tag wait">after: {meta.waitingFor}</span> : null}
        {meta?.worker ? <span className="node-tag">{meta.worker}</span> : null}
      </div>
    );
  }

  if (node.kind === "research") {
    return (
      <div className="node-card-body">
        <p className="node-card-prompt">{meta?.prompt ?? node.detail}</p>
        {meta?.waitingFor ? <span className="node-tag wait">after: {meta.waitingFor}</span> : null}
        {node.status === "verified" ? <p className="node-card-prompt">Open to read the findings.</p> : null}
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

