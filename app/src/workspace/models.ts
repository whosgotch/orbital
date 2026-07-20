// The curated model catalog: the current Claude family, instead of a raw dump
// of every provider model id. Ids are the exact aliases `claude --model`
// accepts; empty id means the CLI's own default.
export type CuratedModel = { id: string; name: string };

export const CURATED_MODELS: CuratedModel[] = [
  { id: "", name: "Default" },
  { id: "claude-opus-4-8", name: "Opus 4.8" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5" },
];

// The model's own thinking levels, exactly the values `claude --effort <level>`
// accepts — not our own invented labels. Empty id means the CLI's own default.
export type EffortLevel = { id: string; name: string };

export const EFFORT_LEVELS: EffortLevel[] = [
  { id: "", name: "Default" },
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
  { id: "max", name: "Max" },
];
