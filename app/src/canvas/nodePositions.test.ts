import { beforeEach, describe, expect, it } from "vitest";
import { forgetNodePosition, loadNodePositions, saveNodePositions } from "./nodePositions";

// Vitest runs on node, which has no localStorage — the smallest stand-in that
// behaves like one, plus a broken variant for the failure paths.
function installStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return items;
}

const KEY = "orbital:node-positions";

describe("nodePositions", () => {
  beforeEach(() => installStorage());

  it("round-trips pinned positions", () => {
    saveNodePositions({ mission_1: { x: 12, y: -34 } });
    expect(loadNodePositions()).toEqual({ mission_1: { x: 12, y: -34 } });
  });

  it("starts empty when nothing was ever saved", () => {
    expect(loadNodePositions()).toEqual({});
  });

  it("survives a store holding junk instead of positions", () => {
    installStorage({ [KEY]: "not json at all" });
    expect(loadNodePositions()).toEqual({});

    installStorage({ [KEY]: JSON.stringify({ ok: { x: 1, y: 2 }, half: { x: 3 }, nope: "somewhere", nan: { x: 0, y: null } }) });
    expect(loadNodePositions()).toEqual({ ok: { x: 1, y: 2 } });
  });

  it("survives a store that refuses to be read or written", () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
      configurable: true,
      writable: true,
    });
    expect(loadNodePositions()).toEqual({});
    expect(() => saveNodePositions({ mission_1: { x: 1, y: 2 } })).not.toThrow();
  });

  it("forgets one node's pin and keeps the rest", () => {
    saveNodePositions({ mission_1: { x: 1, y: 2 }, mission_2: { x: 3, y: 4 } });
    forgetNodePosition("mission_1");
    expect(loadNodePositions()).toEqual({ mission_2: { x: 3, y: 4 } });
  });
});
