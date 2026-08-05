import { useState } from "react";
import type { GitSync } from "./domain";
import { loadGitSync, pushRepo } from "./missionLoopLoader";

const noSync: GitSync = { branch: "", remote: "", upstream: "", ahead: 0, behind: 0 };

// Where the active repo stands against its remote. Read on demand — after a
// commit lands, an amend, or a push — rather than polled: nothing else changes
// it while the app sits idle.
export function useGitSync(repoPath: string) {
  const [sync, setSync] = useState<GitSync>(noSync);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!repoPath) {
      setSync(noSync);
      return;
    }
    try {
      setSync(await loadGitSync(repoPath));
    } catch (cause) {
      console.error("[orbital] git sync failed", cause);
      setSync(noSync);
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
