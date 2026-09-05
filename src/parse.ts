/**
 * Pure parsing/validation for @pify/worktree.
 * No imports from pi packages; no fs/process — fully unit-testable.
 */

export interface WorktreeInfo {
  path: string;
  head: string;
  /** Branch name without refs/heads/, or null when detached. */
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  /** The repository's primary worktree (first entry in porcelain output). */
  primary: boolean;
}

/** Parse `git worktree list --porcelain` output. */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;

  const flush = () => {
    if (current?.path) {
      worktrees.push({
        path: current.path,
        head: current.head ?? "",
        branch: current.branch ?? null,
        detached: current.detached ?? false,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false,
        primary: worktrees.length === 0,
      });
    }
    current = null;
  };

  for (const line of porcelain.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed === "") {
      flush();
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      flush();
      current = { path: trimmed.slice("worktree ".length) };
    } else if (!current) {
      continue;
    } else if (trimmed.startsWith("HEAD ")) {
      current.head = trimmed.slice(5);
    } else if (trimmed.startsWith("branch ")) {
      current.branch = trimmed.slice(7).replace(/^refs\/heads\//, "");
    } else if (trimmed === "detached") {
      current.detached = true;
    } else if (trimmed === "locked" || trimmed.startsWith("locked ")) {
      current.locked = true;
    } else if (trimmed === "prunable" || trimmed.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  flush();
  return worktrees;
}

/**
 * Branch-name safety: git's own rules, restricted further so a name can never
 * smuggle flags or path tricks into an argv (no leading '-', no '..', no
 * control chars, printable subset only).
 */
export function validBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".lock") || name.includes("..") || name.includes("//")) return false;
  if (name.includes("@{") || name === "@") return false;
  return /^[A-Za-z0-9._\-/]+$/.test(name);
}

/** Filesystem-safe directory name for a branch (feature/x → feature-x). */
export function branchToDirName(branch: string): string {
  return branch.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
}

export interface RemovalRisk {
  ok: boolean;
  reasons: string[];
  /** Risks a user may explicitly confirm through (dirty). */
  confirmable: boolean;
}

/** Compare paths the way the local filesystem does (Windows-insensitive). */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Is `childPath` the same as, or under, `parentPath`? Plain string prefixing
 * would read `.../feature-2` as living inside `.../feature`, and worktrees are
 * generated as exactly those siblings.
 */
export function isInside(childPath: string, parentPath: string): boolean {
  const child = normalizePath(childPath);
  const parent = normalizePath(parentPath);
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Find the worktree a user means: an exact branch, a branch under a known
 * namespace ("worker-1" for "agent/worker-1"), a path, or a directory name.
 */
export function resolveWorktree(
  worktrees: WorktreeInfo[],
  target: string,
  prefixes: string[] = ["agent/"],
): WorktreeInfo | null {
  const wanted = target.trim();
  if (!wanted) return null;
  const byBranch = worktrees.find((w) => w.branch === wanted);
  if (byBranch) return byBranch;
  for (const prefix of prefixes) {
    const namespaced = worktrees.find((w) => w.branch === `${prefix}${wanted}`);
    if (namespaced) return namespaced;
  }
  const normalized = normalizePath(wanted);
  const byPath = worktrees.find((w) => normalizePath(w.path) === normalized);
  if (byPath) return byPath;
  return worktrees.find((w) => normalizePath(w.path).split("/").pop() === normalized) ?? null;
}

/** Assess whether a worktree can be removed safely (narumiruna's rails). */
export function assessRemoval(
  target: WorktreeInfo,
  currentCwd: string,
  dirty: boolean,
): RemovalRisk {
  const reasons: string[] = [];

  if (target.primary) reasons.push("it is the primary worktree");
  if (isInside(currentCwd, target.path)) {
    reasons.push("the current session is running inside it");
  }
  if (target.locked) reasons.push("it is locked (git worktree lock)");

  const hard = reasons.length > 0;
  if (dirty) reasons.push("it has uncommitted changes");

  return { ok: reasons.length === 0, reasons, confirmable: !hard && dirty };
}

export function formatWorktrees(worktrees: WorktreeInfo[], dirtyPaths: Set<string>): string {
  if (worktrees.length === 0) return "No worktrees.";
  return worktrees
    .map((w) => {
      const flags = [
        w.primary ? "primary" : "",
        w.detached ? "detached" : "",
        w.locked ? "locked" : "",
        w.prunable ? "prunable" : "",
        dirtyPaths.has(w.path) ? "dirty" : "",
      ]
        .filter(Boolean)
        .join(", ");
      const label = w.branch ?? w.head.slice(0, 8);
      return `${w.path}\n  ${label}${flags ? ` (${flags})` : ""}`;
    })
    .join("\n");
}
