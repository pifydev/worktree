/**
 * Merge orchestration for @pify/worktree, lifted out of the extension so the
 * one case that matters — merging while the session is rooted INSIDE the
 * worktree it would remove — can be unit-tested without a live pi.
 *
 * The rule (same one worktree_remove already enforces via assessRemoval): if
 * ctx.cwd is inside the worktree, removing it would delete the running
 * session's own directory. So we merge, keep the worktree, and tell the user
 * to /worktree exit before removing it.
 */

import { isInside, resolveWorktree, validBranchName, type WorktreeInfo } from "./parse.ts";

export interface MergeDeps {
  hasUI: boolean;
  isDirty(path: string): boolean;
  confirm(title: string, message: string): Promise<boolean>;
  mergeBranch(primaryPath: string, branch: string): Promise<{ ok: boolean; message: string }>;
  removeWorktree(cwd: string, path: string, force: boolean): Promise<{ ok: boolean; output: string }>;
}

export interface MergeOutcome {
  text: string;
  branch: string;
  removed: boolean;
  merged: boolean;
}

export async function runMerge(
  cwd: string,
  worktrees: WorktreeInfo[],
  rawBranch: string,
  deps: MergeDeps,
): Promise<MergeOutcome> {
  const branch = rawBranch.trim();
  if (!validBranchName(branch)) throw new Error(`Invalid branch name ${JSON.stringify(rawBranch)}.`);

  const primary = worktrees.find((w) => w.primary);
  const source = resolveWorktree(worktrees, branch);
  if (!primary) throw new Error("Could not locate the primary worktree.");
  if (!source) throw new Error(`No worktree has branch "${branch}". Use worktree_list.`);
  if (source.primary) throw new Error("That is the primary worktree's own branch.");
  if (deps.isDirty(source.path)) {
    throw new Error(`Worktree ${source.path} has uncommitted changes — commit them there first.`);
  }
  if (deps.isDirty(primary.path)) {
    throw new Error(`The primary worktree has uncommitted changes — commit or stash them first.`);
  }
  if (!deps.hasUI) {
    throw new Error("Merging needs the user's confirmation and no UI is available (fail-closed).");
  }

  // Would removing the source delete the directory this session runs in? If so
  // we keep it — otherwise git (on POSIX) unlinks the session's own cwd, or (on
  // Windows) empties it and fails to rmdir, and every later tool call breaks.
  const inside = isInside(cwd, source.path);
  const sourceBranch = source.branch ?? branch;
  const mergedInto = primary.branch ?? "primary";

  const approved = await deps.confirm(
    "Merge worktree",
    `Merge branch "${sourceBranch}" into "${primary.branch ?? "the primary branch"}" and ` +
      `${inside ? "keep" : "remove"} ${source.path}?`,
  );
  if (!approved) {
    return { text: "The user declined the merge.", branch: sourceBranch, removed: false, merged: false };
  }

  const merge = await deps.mergeBranch(primary.path, sourceBranch);
  if (!merge.ok) throw new Error(merge.message);

  if (inside) {
    return {
      text:
        `Merged "${sourceBranch}" into ${mergedInto}.\n` +
        `This session is rooted in the worktree, so it was KEPT (removing it would delete this ` +
        `session's own directory). Run /worktree exit, then worktree_remove branch="${sourceBranch}" ` +
        `(or /worktree remove ${sourceBranch}) to drop it.`,
      branch: sourceBranch,
      removed: false,
      merged: true,
    };
  }

  const removal = await deps.removeWorktree(cwd, source.path, false);
  const cleanup = removal.ok
    ? `Worktree ${source.path} removed (branch kept).`
    : `Merge done, but removing the worktree failed: ${removal.output}`;
  return {
    text: `Merged "${sourceBranch}" into ${mergedInto}.\n${cleanup}`,
    branch: sourceBranch,
    removed: removal.ok,
    merged: true,
  };
}
