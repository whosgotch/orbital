import { useState } from "react";
import type { RepoCommit } from "./domain";
import { loadCommitDiff, loadRepoHistory } from "./missionLoopLoader";

// Git history of the active workspace: the commit list, and the commit whose
// diff is open in the wide viewer.
export function useRepoHistory(repoPath: string) {
  const [commits, setCommits] = useState<RepoCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [openCommit, setOpenCommit] = useState<RepoCommit | null>(null);
  const [commitDiff, setCommitDiff] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      setCommits(await loadRepoHistory(repoPath));
    } catch (error) {
      console.error("[orbital] history failed", error);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  };

  const open = async (commit: RepoCommit) => {
    setOpenCommit(commit);
    setCommitDiff("");
    try {
      setCommitDiff(await loadCommitDiff(repoPath, commit.hash));
    } catch (error) {
      console.error("[orbital] commit diff failed", error);
      setCommitDiff("");
    }
  };

  const close = () => setOpenCommit(null);

  return { commits, loading, openCommit, commitDiff, refresh, open, close };
}
