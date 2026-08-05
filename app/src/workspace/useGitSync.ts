import { useEffect, useState } from "react";
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
  // A push that works makes its own badge vanish, which reads as "nothing
  // happened". This holds a receipt on screen for a moment so the action is
  // seen to have done something.
  const [justPushed, setJustPushed] = useState(false);

  useEffect(() => {
    if (!justPushed) return;
    const timer = setTimeout(() => setJustPushed(false), 2500);
    return () => clearTimeout(timer);
  }, [justPushed]);

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

  // Returns the failure to report, or "" — git's own words (rejected push,
  // missing credentials) beat anything this layer could invent, and the caller
  // owns the one error surface the app has.
  const push = async (): Promise<string> => {
    if (!repoPath) return "";
    setPushing(true);
    setJustPushed(false);
    try {
      setSync(await pushRepo(repoPath));
      setJustPushed(true);
      return "";
    } catch (cause) {
      console.error("[orbital] push failed", cause);
      void refresh();
      return typeof cause === "string" ? cause : "Failed to push.";
    } finally {
      setPushing(false);
    }
  };

  return { sync, pushing, justPushed, refresh, push };
}
