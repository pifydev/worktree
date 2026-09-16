import { execFile, execFileSync } from "node:child_process";
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
  /** The call was killed by its own timeout (execFileSync/execFile SIGTERM). */
  timedOut?: boolean;
  /** The call was cancelled through its AbortSignal (Esc in pi). */
  aborted?: boolean;
}

/** How long a short, interactive git call may run before it is killed. */
const QUICK_TIMEOUT = 30_000;
/**
 * How long a long checkout/merge may run before it is killed. `worktree add`
 * on a huge repo (or Windows with Defender scanning every file) routinely
 * exceeds 30s; killing it there left a half-created, locked worktree that
 * then blocked its own branch. These run through gitLong (async) so the wait
 * never freezes pi's event loop, and they get a generous deadline instead.
 */
const LONG_TIMEOUT = 600_000;

/**
 * Synchronous git for the short, read-only calls (status/list/rev-parse) whose
 * results everything else is built from. Long, mutating operations go through
 * gitLong so they can be cancelled and never block the UI. The 30s default can
 * be overridden per call.
 */
export function git(cwd: string, args: string[], opts: { timeout?: number } = {}): GitResult {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: opts.timeout ?? QUICK_TIMEOUT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; code?: string; signal?: string };
    return {
      ok: false,
      output: (e.stderr || e.stdout || e.message || "git failed").toString().trim(),
      timedOut: e.signal === "SIGTERM" || e.code === "ETIMEDOUT",
    };
  }
}

export interface LongOpts {
  /** Cancellation from the tool's execute signal (Esc in pi). */
  signal?: AbortSignal;
  /** Deadline in ms; defaults to 10 minutes for the long operations. */
  timeout?: number;
}

/**
 * Asynchronous git for the operations that can legitimately take minutes —
 * `worktree add` (a full checkout), `worktree remove`, and `merge`. Wired to
 * the caller's AbortSignal so Esc stops it, and resolves (never rejects) with
 * a GitResult that flags whether the call timed out or was aborted so the
 * caller can clean up the debris git leaves behind.
 */
export function gitLong(cwd: string, args: string[], opts: LongOpts = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: opts.timeout ?? LONG_TIMEOUT,
        windowsHide: true,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, output: (stdout ?? "").toString().trim() });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        // execFile's own timeout SIGTERM-kills git (killed=true); an AbortSignal
        // rejects with ABORT_ERR. Either way the checkout was cut off mid-way.
        const timedOut = e.killed === true || e.code === "ETIMEDOUT";
        const aborted = e.code === "ABORT_ERR" || e.name === "AbortError" || opts.signal?.aborted === true;
        resolve({
          ok: false,
          output: ((stderr as string) || (stdout as string) || e.message || "git failed").toString().trim(),
          timedOut,
          aborted,
        });
      },
    );
  });
}

export interface CleanupStep {
  label: string;
  args: string[];
}

/**
 * Ordered best-effort cleanup for a `worktree add` that was killed mid-checkout.
 * The admin entry is left LOCKED ("initializing"), so a plain `worktree remove`
 * — even a single --force — refuses; it has to be unlocked first, then
 * force-removed, then pruned, and only a branch WE created with -b is deleted.
 * Pure so the order can be asserted without running a multi-minute git.
 */
export function failedAddCleanupPlan(path: string, branch: string, createdBranch: boolean): CleanupStep[] {
  const steps: CleanupStep[] = [
    { label: `unlock ${path}`, args: ["worktree", "unlock", path] },
    { label: `remove ${path}`, args: ["worktree", "remove", "--force", "--force", path] },
    { label: "prune", args: ["worktree", "prune"] },
  ];
  if (createdBranch) steps.push({ label: `delete branch ${branch}`, args: ["branch", "-D", branch] });
  return steps;
}

/** Run the cleanup steps best-effort (each on its own short deadline), reporting what worked. */
async function runCleanup(cwd: string, steps: CleanupStep[]): Promise<string[]> {
  const cleaned: string[] = [];
  for (const step of steps) {
    const result = await gitLong(cwd, step.args, { timeout: QUICK_TIMEOUT });
    if (result.ok) cleaned.push(step.label);
  }
  return cleaned;
}

/** Message for a `worktree add` that finished with an error, cleaning up if it was killed/cancelled. */
async function addFailureMessage(
  cwd: string,
  result: GitResult,
  path: string,
  branch: string,
  createdBranch: boolean,
): Promise<string> {
  // Only a killed/cancelled add leaves the locked half-worktree; ordinary git
  // errors (bad ref, occupied path) created nothing to clean up.
  if (!result.timedOut && !result.aborted) return result.output;
  const cleaned = await runCleanup(cwd, failedAddCleanupPlan(path, branch, createdBranch));
  const why = result.aborted
    ? "The worktree checkout was cancelled"
    : "The worktree checkout exceeded its 10-minute deadline and was stopped";
  const note = cleaned.length
    ? ` Cleaned up: ${cleaned.join("; ")}.`
    : " Could not auto-clean the partial worktree — run /worktree prune, or git worktree unlock/remove manually.";
  return `${why}.${note}`;
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
  // Name the folder after the PRIMARY worktree, not `git rev-parse
  // --show-toplevel`: inside a linked worktree the latter returns the linked
  // root, so a create-from-inside-an-entered-worktree would nest new worktrees
  // under ~/.worktrees/<other-branch>/ instead of ~/.worktrees/<repo>/. git
  // lists the main worktree first, and parse.ts marks it primary.
  const primary = listWorktrees(cwd).find((w) => w.primary)?.path ?? top;
  const repo = primary ? basename(primary) : "repo";
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
export async function createWorktree(
  cwd: string,
  branch: string,
  base?: string,
  opts: LongOpts = {},
): Promise<CreateResult> {
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
    // "--" ends option parsing so path/branch can never be read as flags even
    // if validation upstream is ever bypassed (defense in depth vs arg injection).
    const result = await gitLong(cwd, ["worktree", "add", "--", path, branch], opts);
    return {
      ok: result.ok,
      path,
      base: branch,
      createdBranch: false,
      message: result.ok ? `Checked out existing branch "${branch}".` : await addFailureMessage(cwd, result, path, branch, false),
    };
  }

  const baseRef = base ?? "HEAD";
  const result = await gitLong(cwd, ["worktree", "add", "-b", branch, "--", path, baseRef], opts);
  return {
    ok: result.ok,
    path,
    base: baseRef === "HEAD" ? currentShortHead(cwd) : baseRef,
    createdBranch: true,
    message: result.ok ? `Created branch "${branch}".` : await addFailureMessage(cwd, result, path, branch, true),
  };
}

export function removeWorktree(cwd: string, path: string, force: boolean, opts: LongOpts = {}): Promise<GitResult> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), path];
  return gitLong(cwd, args, opts);
}

export function pruneWorktrees(cwd: string): GitResult {
  return git(cwd, ["worktree", "prune", "-v"]);
}

export interface MergeResult {
  ok: boolean;
  message: string;
}

/** Merge a worktree's branch into the primary worktree's current branch. */
export async function mergeBranch(primaryPath: string, branch: string, opts: LongOpts = {}): Promise<MergeResult> {
  const result = await gitLong(primaryPath, ["merge", "--no-edit", branch], opts);
  if (!result.ok && isDirty(primaryPath)) {
    // A failed merge may leave conflicts — abort to restore a clean state.
    await gitLong(primaryPath, ["merge", "--abort"], opts);
    return {
      ok: false,
      message: `Merge of "${branch}" conflicts — aborted, primary worktree restored. Resolve manually:\n${result.output}`,
    };
  }
  return { ok: result.ok, message: result.output };
}
