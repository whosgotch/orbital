import { useEffect, useState } from "react";
import { CURATED_MODELS, type CuratedModel } from "./models";
import { loadModels } from "./missionLoopLoader";

// The merged model list is fetched at most once per app session — every
// component that opens a model picker shares this module-level cache instead
// of each triggering its own worker call.
let cache: CuratedModel[] | null = null;
let inflight: Promise<CuratedModel[]> | null = null;

async function fetchModels(): Promise<CuratedModel[]> {
  const models = await loadModels();
  return models.map((model) => ({ id: model.id, name: model.display_name }));
}

// Every model the CLI supports, for the model pickers in TopBar and GraphMap.
// Falls back to the curated static list (models.ts) on any error, so the
// picker never breaks when the worker call fails.
export function useModels(): CuratedModel[] {
  const [models, setModels] = useState<CuratedModel[]>(cache ?? CURATED_MODELS);

  useEffect(() => {
    if (cache) {
      return; // already captured by the useState initializer above
    }
    if (!inflight) {
      inflight = fetchModels().catch((error) => {
        console.error("[orbital] list models failed", error);
        return CURATED_MODELS;
      });
    }
    let cancelled = false;
    inflight.then((result) => {
      cache = result;
      if (!cancelled) setModels(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return models;
}
