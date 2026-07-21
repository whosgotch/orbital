import { describe, expect, it } from "vitest";
import { detectIntent } from "./intent";

describe("detectIntent", () => {
  it("routes text ending in a question mark to research", () => {
    expect(detectIntent("What does this module do?")).toBe("research");
  });

  it("routes knowledge-request imperatives to research", () => {
    expect(detectIntent("Explain how the worker retries failed runs")).toBe("research");
  });

  it("routes plain task text to create", () => {
    expect(detectIntent("Add a retry button to the run panel")).toBe("create");
  });

  it("keeps ambiguous verbs like fix on create", () => {
    expect(detectIntent("fix the login bug")).toBe("create");
    expect(detectIntent("do a cleanup pass of the docs")).toBe("create");
  });

  it("routes a multi-line backlog to create", () => {
    expect(detectIntent("Add logging\nWire up the button\nRefactor the config loader")).toBe("create");
  });

  it("returns create for empty or whitespace-only text", () => {
    expect(detectIntent("")).toBe("create");
    expect(detectIntent("   \n  ")).toBe("create");
  });

  it("is case-insensitive on question words and imperatives", () => {
    expect(detectIntent("WHAT is happening here")).toBe("research");
  });
});
