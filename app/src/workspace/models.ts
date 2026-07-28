// A model as the worker reports it, read out of the installed claude CLI so the
// picker tracks whatever that CLI actually supports. `effortLevels` are the
// exact `--effort` values this model accepts — an empty list means the model
// has no thinking levels and effort must not be sent for it.
export type Model = {
  id: string;
  name: string;
  effortLevels: string[];
  defaultEffort: string;
};

// Every level the CLI accepts, used only where the real per-model list is
// unknown.
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Last resort for when the claude binary cannot be read at all. Kept short on
// purpose: the CLI is the real source, and this only has to keep the picker
// from being empty.
export const FALLBACK_MODELS: Model[] = [
  { id: "claude-fable-5", name: "Fable 5", effortLevels: ALL_EFFORTS, defaultEffort: "high" },
  { id: "claude-opus-5", name: "Opus 5", effortLevels: ALL_EFFORTS, defaultEffort: "high" },
  { id: "claude-sonnet-5", name: "Sonnet 5", effortLevels: ALL_EFFORTS, defaultEffort: "high" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", effortLevels: [], defaultEffort: "" },
];

// Display names for the levels `claude --effort` accepts. Which of them a given
// model offers comes from that model's own effortLevels, never from this map.
const EFFORT_NAMES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortName(level: string): string {
  return EFFORT_NAMES[level] ?? level;
}

// Claude Code model ids can carry a context-window suffix (`claude-fable-5[1m]`)
// that the picker's plain ids don't have. Matching on the base id lets a model
// configured that way still light up as the current one.
export function baseModelId(id: string): string {
  return id.replace(/\[.*\]$/, "");
}

// Matches a model id against the catalog. The id a run reports back is the
// fully resolved one, which can be a dated snapshot of a catalog entry
// (`claude-haiku-4-5-20251001` for `claude-haiku-4-5`), so an exact match is
// tried first and then the longest catalog id the given one extends.
export function findModel(models: Model[], id: string): Model | undefined {
  const base = baseModelId(id);
  if (!base) return undefined;

  const exact = models.find((model) => baseModelId(model.id) === base);
  if (exact) return exact;

  return models
    .filter((model) => base.startsWith(`${baseModelId(model.id)}-`))
    .sort((a, b) => b.id.length - a.id.length)[0];
}

// Resolves the thinking level actually sent to the CLI. A preference that the
// selected model doesn't offer (Haiku takes none, Sonnet 4.6 takes no xhigh)
// falls back to that model's own default rather than being sent and rejected.
export function resolveEffort(preferred: string, model: Model | undefined): string {
  const levels = model ? model.effortLevels : ALL_EFFORTS;
  if (levels.length === 0) return "";
  if (preferred && levels.includes(preferred)) return preferred;
  if (model?.defaultEffort && levels.includes(model.defaultEffort)) return model.defaultEffort;
  return levels.includes("high") ? "high" : levels[levels.length - 1];
}
