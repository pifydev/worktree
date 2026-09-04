import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { branchToDirName, parseWorktreeList, type WorktreeInfo } from "./parse.ts";

/**
 * Git operations for @pify/worktree. Every call is execFile with an argv
 * array — no shell, no interpolation, ever (narumiruna's rule). Errors
 * surface git's own stderr so the agent/user sees the real reason.
 */

export interface GitResult {
  ok: boolean;
  output: string;
}

export function git(cwd: string, args: string[]): GitResult {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, output: (e.stderr || e.stdout || e.message || "git failed").toString().trim() };
  }
}

export function repoToplevel(cwd: string): string | null {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.output : null;
}

export function listWorktrees(cwd: string): WorktreeInfo[] {
  const result = git(cwd, ["worktree", "list", "--porcelain"]);
  return result.ok ? parseWorktreeList(result.output) : [];
}

export function isDirty(worktreePath: string): boolean {
  const result = git(worktreePath, ["status", "--porcelain"]);
  return result.ok && result.output !== "";
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

export function currentShortHead(cwd: string): string {
  const result = git(cwd, ["rev-parse", "--short", "HEAD"]);
  return result.ok ? result.output : "unknown";
}

/** Suggested location: ~/.worktrees/<repo-name>/<branch-dir> (narumiruna). */
export function suggestPath(cwd: string, branch: string): string {
  const top = repoToplevel(cwd);
  const repo = top ? basename(top) : "repo";
  let candidate = join(homedir(), ".worktrees", repo, branchToDirName(branch));
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = join(homedir(), ".worktrees", repo, `${branchToDirName(branch)}-${counter}`);
    counter++;
  }
  return candidate;
}

export interface CreateResult {
  ok: boolean;
  path: string;
  base: string;
  createdBranch: boolean;
  message: string;
}

/**
 * Create a worktree: a NEW branch from HEAD (default) or an existing,
 * unoccupied local branch checked out into the new worktree.
 */
export function createWorktree(cwd: string, branch: string, base?: string): CreateResult {
  const path = suggestPath(cwd, branch);
  const exists = branchExists(cwd, branch);

  if (exists) {
    const occupied = listWorktrees(cwd).find((w) => w.branch === branch);
    if (occupied) {
      return {
        ok: false,
        path: occupied.path,
        base: "",
        createdBranch: false,
        message: `Branch "${branch}" is already checked out at ${occupied.path}.`,
      };
    }
    const result = git(cwd, ["worktree", "add", path, branch]);
    return {
      ok: result.ok,
      path,
      base: branch,
      createdBranch: false,
      message: result.ok ? `Checked out existing branch "${branch}".` : result.output,
    };
  }

  const baseRef = base ?? "HEAD";
  const result = git(cwd, ["worktree", "add", "-b", branch, path, baseRef]);
  return {
    ok: result.ok,
    path,
    base: baseRef === "HEAD" ? currentShortHead(cwd) : baseRef,
    createdBranch: true,
    message: result.ok ? `Created branch "${branch}".` : result.output,
  };
}

export function removeWorktree(cwd: string, path: string, force: boolean): GitResult {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), path];
  return git(cwd, args);
}

export function pruneWorktrees(cwd: string): GitResult {
  return git(cwd, ["worktree", "prune", "-v"]);
}

export interface MergeResult {
  ok: boolean;
  message: string;
}

/** Merge a worktree's branch into the primary worktree's current branch. */
export function mergeBranch(primaryPath: string, branch: string): MergeResult {
  const result = git(primaryPath, ["merge", "--no-edit", branch]);
  if (!result.ok && isDirty(primaryPath)) {
    // A failed merge may leave conflicts — abort to restore a clean state.
    git(primaryPath, ["merge", "--abort"]);
    return {
      ok: false,
      message: `Merge of "${branch}" conflicts — aborted, primary worktree restored. Resolve manually:\n${result.output}`,
    };
  }
  return { ok: result.ok, message: result.output };
}
