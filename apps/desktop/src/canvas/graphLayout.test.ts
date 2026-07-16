import { describe, expect, it } from "vitest";
import type { WorkspaceGraphEdge, WorkspaceGraphNode } from "./graph";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, LANE_GAP } from "./graphLayout";

function node(id: string, kind: WorkspaceGraphNode["kind"], missionId?: string, repositoryId = "r1"): WorkspaceGraphNode {
  return { id, kind, label: id, detail: "", mission_id: missionId, repository_id: repositoryId };
}

const edge = (from: string, to: string): WorkspaceGraphEdge => ({ id: `${from}_${to}`, from, to, kind: "owns" });
const thenEdge = (from: string, to: string): WorkspaceGraphEdge => ({ id: `then_${from}_${to}`, from, to, kind: "then" });

// Top-left rect intersection, using the layout's fixed node footprint.
function rectsOverlap(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x < b.x + NODE_WIDTH && b.x < a.x + NODE_WIDTH && a.y < b.y + NODE_HEIGHT && b.y < a.y + NODE_HEIGHT;
}

const pipeline: WorkspaceGraphNode[] = [
  node("r1", "repo"),
  node("m1", "task", "m1"),
  node("m1_agent", "agent", "m1"),
  node("m1_patch", "changes", "m1"),
  node("m2", "task", "m2"),
];

const pipelineEdges = [edge("r1", "m1"), edge("m1", "m1_agent"), edge("m1_agent", "m1_patch"), edge("r1", "m2")];

describe("layoutGraph", () => {
  it("positions every node on a finite grid", () => {
    const positions = layoutGraph(pipeline, pipelineEdges);
    expect(Object.keys(positions).sort()).toEqual(pipeline.map((n) => n.id).sort());
    for (const { x, y } of Object.values(positions)) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("advances one column per depth step and aligns stages across lanes", () => {
    const positions = layoutGraph(pipeline, pipelineEdges);
    expect(positions.r1.x).toBeLessThan(positions.m1.x);
    expect(positions.m1.x).toBeLessThan(positions.m1_agent.x);
    expect(positions.m1_agent.x).toBeLessThan(positions.m1_patch.x);
    // Both tasks are depth 1 from the repo, so they share a column.
    expect(positions.m2.x).toBe(positions.m1.x);
  });

  it("gives each mission its own lane", () => {
    const positions = layoutGraph(pipeline, pipelineEdges);
    expect(positions.m1.y).not.toBe(positions.m2.y);
  });

  it("survives an accidental cycle without hanging", () => {
    const nodes = [node("a", "task", "m1"), node("b", "task", "m1")];
    const positions = layoutGraph(nodes, [edge("a", "b"), edge("b", "a")]);
    expect(Object.keys(positions)).toHaveLength(2);
  });
});

describe("dependency-aware lane order", () => {
  it("keeps a chained family contiguous, right after its root, without reordering past an older unrelated mission", () => {
    // "older" and "d" are unrelated root missions; "a" is a research mission
    // whose extracted tasks "b" and "c" chain off it via "then" edges.
    const nodes = [
      node("r1", "repo"),
      node("older", "task", "older"),
      node("a", "research", "a"),
      node("b", "task", "b"),
      node("c", "task", "c"),
      node("d", "task", "d"),
    ];
    const edges = [edge("r1", "older"), edge("r1", "a"), thenEdge("a", "b"), thenEdge("a", "c"), edge("r1", "d")];
    const positions = layoutGraph(nodes, edges);

    // Roots keep creation order: "older" was created before the family, so
    // its lane still precedes it — this is not a global dependency reorder.
    expect(positions.older.y).toBeLessThan(positions.a.y);
    // The extracted tasks land immediately after their research root...
    expect(positions.a.y).toBeLessThan(positions.b.y);
    expect(positions.b.y).toBeLessThan(positions.c.y);
    // ...and before the next root mission, created after the whole family.
    expect(positions.c.y).toBeLessThan(positions.d.y);

    // Every lane here is a single node, so lanes stack at a uniform step.
    // Equal consecutive gaps confirm the family occupies *consecutive* lanes
    // rather than merely landing somewhere after "a".
    const step = positions.a.y - positions.older.y;
    expect(positions.b.y - positions.a.y).toBeCloseTo(step);
    expect(positions.c.y - positions.b.y).toBeCloseTo(step);
    expect(positions.d.y - positions.c.y).toBeCloseTo(step);
  });

  it("keeps repo lane groups together and orders each repo's own families independently", () => {
    const nodes = [
      node("r1", "repo"),
      node("r2", "repo"),
      node("r1_older", "task", "r1_older", "r1"),
      node("r2_m", "task", "r2_m", "r2"),
      node("r1_child", "task", "r1_child", "r1"),
    ];
    const edges = [edge("r1", "r1_older"), edge("r2", "r2_m"), thenEdge("r1_older", "r1_child")];
    const positions = layoutGraph(nodes, edges);
    // r1's family (older -> child) stays contiguous...
    expect(positions.r1_child.y).toBeGreaterThan(positions.r1_older.y);
    // ...and every r1 lane comes before r2's, even though r2_m was created
    // (appears in the nodes array) before r1_child.
    expect(positions.r1_older.y).toBeLessThan(positions.r2_m.y);
    expect(positions.r1_child.y).toBeLessThan(positions.r2_m.y);
  });
});

describe("no overlaps", () => {
  it("never lets two node footprints intersect across several lanes and repos", () => {
    const nodes = [
      node("r1", "repo"),
      node("r2", "repo"),
      node("m1", "task", "m1"),
      node("m1_agent", "agent", "m1"),
      node("m1_patch", "changes", "m1"),
      node("m1_verify", "verify", "m1"),
      node("m2", "task", "m2"),
      node("m3", "task", "m3"), // chained off m1
      node("m4", "research", "m4"),
      node("m5", "task", "m5", "r2"),
    ];
    const edges = [
      edge("r1", "m1"),
      edge("m1", "m1_agent"),
      edge("m1_agent", "m1_patch"),
      edge("m1_patch", "m1_verify"),
      edge("r1", "m2"),
      thenEdge("m1", "m3"),
      edge("r1", "m4"),
      edge("r2", "m5"),
    ];
    const positions = layoutGraph(nodes, edges);
    const ids = Object.keys(positions);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(rectsOverlap(positions[ids[i]], positions[ids[j]])).toBe(false);
      }
    }
  });
});

describe("pinned nodes", () => {
  const nodes = [node("r1", "repo"), node("m1", "task", "m1"), node("m2", "task", "m2")];
  const edges = [edge("r1", "m1"), edge("r1", "m2")];

  it("keeps a new mission's lane clear of a node the user dragged into its natural slot", () => {
    const basePositions = layoutGraph(nodes, edges);
    // Pretend the user dragged m1 down into the spot m2 would naturally land.
    const pinned = { m1: basePositions.m2 };
    const positions = layoutGraph(nodes, edges, pinned);
    expect(rectsOverlap(positions.m2, pinned.m1)).toBe(false);
  });

  it("leaves a lane holding a pinned node at its own stacked slot", () => {
    const base = layoutGraph(nodes, edges);
    const pinned = { m1: { x: 900, y: 900 } };
    const positions = layoutGraph(nodes, edges, pinned);
    expect(positions.m1).toEqual(base.m1);
  });
});

describe("repo separation", () => {
  it("keeps two repo nodes with close average lane ys at least NODE_HEIGHT + LANE_GAP apart", () => {
    const nodes = [
      node("r1", "repo"),
      node("r2", "repo"), // no missions of its own yet: falls back to an index-based y
      node("m1", "task", "m1", "r1"),
    ];
    const edges = [edge("r1", "m1")];
    const positions = layoutGraph(nodes, edges);
    expect(Math.abs(positions.r2.y - positions.r1.y)).toBeGreaterThanOrEqual(NODE_HEIGHT + LANE_GAP);
  });
});
