// The curated model catalog: the current Claude family, instead of a raw dump
// of every provider model id. Ids are the exact aliases `claude --model`
// accepts. Every entry is a real model — picking one overrides whatever the
// CLI would have chosen on its own.
export type CuratedModel = { id: string; name: string };

export const CURATED_MODELS: CuratedModel[] = [
  { id: "claude-opus-4-8", name: "Opus 4.8" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5" },
];

// The model's own thinking levels, exactly the values `claude --effort <level>`
// accepts — not our own invented labels.
export type EffortLevel = { id: string; name: string };

export const EFFORT_LEVELS: EffortLevel[] = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
  { id: "max", name: "Max" },
];

// Effort is always sent, so a launch with nothing stored still resolves to a
// real level instead of falling through to the CLI's own.
export const DEFAULT_EFFORT = "medium";
