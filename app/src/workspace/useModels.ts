import { useEffect, useState } from "react";
import { FALLBACK_MODELS, type Model } from "./models";
import { loadModels } from "./missionLoopLoader";

// What the pickers need: the models the installed CLI offers, and the model and
// thinking level already configured in Claude Code so Orbital opens on the same
// ones instead of a default of its own.
export type ModelCatalog = {
  models: Model[];
  defaultModel: string;
  defaultEffort: string;
};

const FALLBACK_CATALOG: ModelCatalog = {
  models: FALLBACK_MODELS,
  defaultModel: "",
  defaultEffort: "",
};

// The catalog is fetched at most once per app session — every component that
// opens a model picker shares this module-level cache instead of each
// triggering its own worker call.
let cache: ModelCatalog | null = null;
let inflight: Promise<ModelCatalog> | null = null;

async function fetchCatalog(): Promise<ModelCatalog> {
  const payload = await loadModels();
  return {
    models: payload.models.map((model) => ({
      id: model.id,
      name: model.display_name,
      effortLevels: model.effort_levels ?? [],
      defaultEffort: model.default_effort ?? "",
    })),
    defaultModel: payload.default_model ?? "",
    defaultEffort: payload.default_effort ?? "",
  };
}

// Falls back to the static list (models.ts) on any error, so the picker never
// breaks when the worker call fails.
export function useModelCatalog(): ModelCatalog {
  const [catalog, setCatalog] = useState<ModelCatalog>(cache ?? FALLBACK_CATALOG);

  useEffect(() => {
    if (cache) {
      return; // already captured by the useState initializer above
    }
    if (!inflight) {
      inflight = fetchCatalog().catch((error) => {
        console.error("[orbital] list models failed", error);
        return FALLBACK_CATALOG;
      });
    }
    let cancelled = false;
    inflight.then((result) => {
      cache = result;
      if (!cancelled) setCatalog(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return catalog;
}

export function useModels(): Model[] {
  return useModelCatalog().models;
}
