import { useState } from "react";
import type { GitSync } from "./domain";
import { loadGitSync, pushRepo } from "./missionLoopLoader";

// Where the active repo stands against its remote. Read on demand — after a
// commit lands, an amend, or a push — rather than polled: nothing else changes
// it while the app sits idle.
//
// undefined means "not read yet", which is not the same as "no remote": the
// gate must say nothing until it knows, or it accuses a repo with a perfectly
// good origin of having none.
export function useGitSync(repoPath: string) {
  const [sync, setSync] = useState<GitSync | undefined>(undefined);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!repoPath) {
      setSync(undefined);
      return;
    }
    try {
      setSync(await loadGitSync(repoPath));
    } catch (cause) {
      console.error("[orbital] git sync failed", cause);
      setSync(undefined);
    }
  };

  const push = async () => {
    if (!repoPath) return;
    setError("");
    setPushing(true);
    try {
      setSync(await pushRepo(repoPath));
    } catch (cause) {
      console.error("[orbital] push failed", cause);
      setError(typeof cause === "string" ? cause : "Failed to push.");
      void refresh();
    } finally {
      setPushing(false);
    }
  };

  return { sync, pushing, error, refresh, push };
}
