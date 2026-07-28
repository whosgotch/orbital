import { describe, expect, it } from "vitest";
import { baseModelId, findModel, resolveEffort, type Model } from "./models";

const opus: Model = {
  id: "claude-opus-5",
  name: "Opus 5",
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "high",
};
const sonnet46: Model = {
  id: "claude-sonnet-4-6",
  name: "Sonnet 4.6",
  effortLevels: ["low", "medium", "high", "max"],
  defaultEffort: "",
};
const haiku: Model = {
  id: "claude-haiku-4-5",
  name: "Haiku 4.5",
  effortLevels: [],
  defaultEffort: "",
};
const models = [opus, sonnet46, haiku];

describe("findModel", () => {
  it("matches a model configured with a context-window suffix", () => {
    expect(findModel(models, "claude-opus-5[1m]")).toBe(opus);
  });

  it("returns nothing for an unset or unknown model", () => {
    expect(findModel(models, "")).toBeUndefined();
    expect(findModel(models, "claude-opus-4-1")).toBeUndefined();
  });

  it("strips only a trailing bracket suffix", () => {
    expect(baseModelId("claude-fable-5[1m]")).toBe("claude-fable-5");
    expect(baseModelId("claude-fable-5")).toBe("claude-fable-5");
  });
});

describe("resolveEffort", () => {
  it("keeps a preference the model offers", () => {
    expect(resolveEffort("xhigh", opus)).toBe("xhigh");
  });

  it("falls back to the model's own default when the preference is unsupported", () => {
    // Sonnet 4.6 has no xhigh level; sending it would be rejected by the CLI.
    expect(resolveEffort("xhigh", sonnet46)).toBe("high");
  });

  it("sends nothing for a model with no thinking levels", () => {
    expect(resolveEffort("high", haiku)).toBe("");
  });

  it("falls back to high when the model is unknown", () => {
    expect(resolveEffort("", undefined)).toBe("high");
    expect(resolveEffort("max", undefined)).toBe("max");
  });
});
