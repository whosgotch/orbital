// Which repositories the workspace has open, persisted so a new session
// reopens where the last one left off — plus a most-recent-first list that
// backs the "Recent" picker in the workspace popover.
const RECENT_KEY = "orbital:recent-repos";
const OPEN_KEY = "orbital:open-repos";
const RECENT_LIMIT = 8;

function read(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function recentRepoPaths(): string[] {
  return read(RECENT_KEY);
}

export function lastOpenRepoPaths(): string[] {
  return read(OPEN_KEY);
}

export function rememberRecentRepo(path: string) {
  const next = [path, ...recentRepoPaths().filter((item) => item !== path)].slice(0, RECENT_LIMIT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

// Drop a path that no longer opens (moved or deleted repo).
export function forgetRecentRepo(path: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentRepoPaths().filter((item) => item !== path)));
}

export function persistOpenRepos(paths: string[]) {
  localStorage.setItem(OPEN_KEY, JSON.stringify(paths));
}

export function repoNameFromPath(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
