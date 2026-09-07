/**
 * Entering a worktree without losing the conversation.
 *
 * Creating a worktree was only ever half the job: pi binds `read`, `edit`,
 * `bash` and `@` completion to the session's cwd, and a session cannot change
 * its own cwd. So until now this package could hand you a path and a
 * suggestion to open a second terminal — and everything you had discussed
 * stayed in the terminal you left.
 *
 * The way through is a replacement session: fork the current session file
 * into the worktree and switch to it. The conversation comes along, the tools
 * rebind, and the branch you were reading about is the branch you are now in.
 * (Mechanism from FradSer/pi-packages' utils, which found it first.)
 *
 * Pure helpers only — the switch itself needs the host and lives in the
 * extension.
 */

export const WORKTREE_SESSION_ENTRY = "pify-worktree-session";

export interface WorktreeSession {
  /** Absolute path of the worktree this session is rooted in. */
  path: string;
  branch: string | null;
  /** Session file we forked from, so ExitWorktree knows where to go back. */
  parentSession: string;
  /** True when entering created the worktree, so leaving may offer to remove it. */
  created: boolean;
  enteredAt: number;
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** The worktree state this session was entered with, if any. */
export function readWorktreeSession(entries: readonly BranchEntryLike[]): WorktreeSession | null {
  let state: WorktreeSession | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== WORKTREE_SESSION_ENTRY) continue;
    const data = entry.data as Partial<WorktreeSession> | null;
    if (!data || typeof data.path !== "string" || !data.path) continue;
    state = {
      path: data.path,
      branch: typeof data.branch === "string" ? data.branch : null,
      parentSession: typeof data.parentSession === "string" ? data.parentSession : "",
      created: data.created === true,
      enteredAt: typeof data.enteredAt === "number" ? data.enteredAt : 0,
    };
  }
  return state;
}

export type EnterProblem =
  | { kind: "no-session"; message: string }
  | { kind: "unwritten"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "already-here"; message: string };

export interface EnterPlan {
  target: { path: string; branch: string | null };
  parentSession: string;
}

/** What we know about the session we would be forking. */
export interface ParentSession {
  file: string | null;
  /**
   * Whether that file exists with entries in it. pi keeps a session in memory
   * until the first assistant message, so a brand-new session has a name on
   * disk and nothing behind it — and forking from it throws.
   */
  onDisk: boolean;
}

function samePath(a: string, b: string): boolean {
  return a.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() ===
    b.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Decide whether entering is possible before anything is forked. Each refusal
 * names which of the four things went wrong, because the fixes differ: start a
 * persisted session, say something first, create the worktree, or do nothing
 * at all.
 */
export function planEnter(
  cwd: string,
  parent: ParentSession,
  target: { path: string; branch: string | null } | null,
): EnterPlan | EnterProblem {
  if (!parent.file) {
    return {
      kind: "no-session",
      message:
        "Entering a worktree forks this session, so it needs a persisted one. Start pi without --no-session.",
    };
  }
  if (!parent.onDisk) {
    return {
      kind: "unwritten",
      message:
        "This session has not been written to disk yet — pi saves it once the agent has replied, and there is " +
        "nothing to carry across until then. Ask something first, or open the worktree in its own pi.",
    };
  }
  if (!target) {
    return {
      kind: "not-found",
      message: "No worktree matches that. /worktree list shows them; /worktree create <branch> makes one.",
    };
  }
  if (samePath(cwd, target.path)) {
    return { kind: "already-here", message: "This session is already rooted in that worktree." };
  }
  return { target, parentSession: parent.file };
}

export function enteredNote(session: WorktreeSession): string {
  const branch = session.branch ? ` on ${session.branch}` : "";
  return [
    `Entered worktree ${session.path}${branch}.`,
    "read, edit, bash and @ completion are rooted here now; the conversation came with you.",
    "/worktree exit returns to the session you came from.",
  ].join(" ");
}

export function exitNote(session: WorktreeSession): string {
  return [
    `Left the worktree at ${session.path}.`,
    session.created
      ? "It was created by entering, and is still there — /worktree remove drops it, worktree_merge merges it back."
      : "It is untouched.",
  ].join(" ");
}
