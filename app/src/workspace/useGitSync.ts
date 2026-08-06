import { useEffect, useState } from "react";
import type { GitSync } from "./domain";
import { loadBranches, loadGitSync, pushRepo, switchBranch } from "./missionLoopLoader";

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
  const [branches, setBranches] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);

  // Render-phase reset: a list read for one repo must never be offered as
  // another's, not even for the moment before the fresh read lands.
  const [branchesFor, setBranchesFor] = useState(repoPath);
  if (branchesFor !== repoPath) {
    setBranchesFor(repoPath);
    setBranches([]);
  }

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

  // Read when the picker opens, not kept warm: branches come and go from
  // terminals and other tools while Orbital sits there.
  //
  // Reports its failure like push does rather than just emptying the list: a
  // silent empty list reads as "this repo has no branches", which is never true
  // and hides whatever actually went wrong.
  const refreshBranches = async (): Promise<string> => {
    if (!repoPath) return "";
    try {
      setBranches(await loadBranches(repoPath));
      return "";
    } catch (cause) {
      console.error("[orbital] branch list failed", cause);
      setBranches([]);
      return typeof cause === "string" ? cause : "Failed to list branches.";
    }
  };

  // Same contract as push: git's refusal (uncommitted work in the way, a name
  // already taken) is returned for the caller's one error surface to show.
  const switchTo = async (branch: string, create: boolean): Promise<string> => {
    if (!repoPath) return "";
    setSwitching(true);
    setJustPushed(false);
    try {
      setSync(await switchBranch(repoPath, branch, create));
      void refreshBranches();
      return "";
    } catch (cause) {
      console.error("[orbital] branch switch failed", cause);
      void refresh();
      return typeof cause === "string" ? cause : `Failed to switch to ${branch}.`;
    } finally {
      setSwitching(false);
    }
  };

  return { sync, pushing, justPushed, branches, switching, refresh, push, refreshBranches, switchTo };
}
