// The curated model catalog: the current Claude family with plain-language
// guidance, instead of a raw dump of every provider model id. Ids are the
// exact aliases `claude --model` accepts; empty id means the CLI's own default.
export type CuratedModel = { id: string; name: string; blurb: string };

export const CURATED_MODELS: CuratedModel[] = [
  { id: "", name: "Default", blurb: "Whatever your claude CLI is set to" },
  { id: "claude-opus-4-8", name: "Opus 4.8", blurb: "Deep work — planning, big refactors, gnarly bugs" },
  { id: "claude-sonnet-5", name: "Sonnet 5", blurb: "Balanced daily driver for most tasks" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", blurb: "Fast and cheap — small, well-defined changes" },
];
