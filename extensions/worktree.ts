/**
 * @pify/worktree — safe git-worktree management for pi.
 *
 * The foundation for parallel MUTATING work: create isolated worktrees the
 * agent (or you) can build in without touching the main checkout. Windows-
 * first and dependency-free — no tmux, no daemons; every git call is an
 * execFile argv (no shell, no interpolation — narumiruna's rule), and
 * removal runs behind safety rails: primary/current/locked refuse outright,
 * dirty needs explicit confirmation (fail-closed when headless).
 *
 * Spawning agents INTO worktrees is deliberately v0.2 integration work with
 * @pify/subagent and @pify/swarm — v0.1 hands off cleanly: every created
 * worktree's result says how to open pi there.
 *
 * Design synthesis: guarded manager + safety checks + path suggestion
 * (@narumitw/pi-worktree), merge-back cleanup flow (rielj/pi-git-worktrees,
 * minus the tmux), worktree-as-concurrency-safety framing (pi-napkin).
 */
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";

import { Type } from "typebox";

import {
  createWorktree,
  isDirty,
  listWorktrees,
  mergeBranch,
  pruneWorktrees,
  removeWorktree,
  repoToplevel,
} from "../src/git.ts";
import { assessRemoval, formatWorktrees, resolveWorktree, validBranchName } from "../src/parse.ts";
import {
  WORKTREE_SESSION_ENTRY,
  enteredNote,
  exitNote,
  planEnter,
  readWorktreeSession,
  type WorktreeSession,
} from "../src/enter.ts";

type UiContext = ExtensionContext;
type CommandContext = ExtensionCommandContext;

export default function worktree(pi: ExtensionAPI) {
  function requireRepo(ctx: UiContext): string {
    const top = repoToplevel(ctx.cwd);
    if (!top) throw new Error("Not inside a git repository.");
    return top;
  }

  function listText(ctx: UiContext): string {
    const worktrees = listWorktrees(ctx.cwd);
    const dirty = new Set(worktrees.filter((w) => isDirty(w.path)).map((w) => w.path));
    return formatWorktrees(worktrees, dirty);
  }

  function resolveTarget(ctx: UiContext, target: string) {
    return resolveWorktree(listWorktrees(ctx.cwd), target);
  }

  /**
   * Merge a worktree branch back into the primary worktree and remove the
   * worktree. Shared by the tool and the /worktree route so both halves of
   * the isolation loop behave identically. Throws on anything unsafe.
   */
  async function mergeWorktree(
    ctx: UiContext,
    rawBranch: string,
  ): Promise<{ text: string; branch: string; removed: boolean; merged: boolean }> {
    requireRepo(ctx);
    const branch = rawBranch.trim();
    if (!validBranchName(branch)) throw new Error(`Invalid branch name ${JSON.stringify(rawBranch)}.`);

    const worktrees = listWorktrees(ctx.cwd);
    const primary = worktrees.find((w) => w.primary);
    const source = resolveWorktree(worktrees, branch);
    if (!primary) throw new Error("Could not locate the primary worktree.");
    if (!source) throw new Error(`No worktree has branch "${branch}". Use worktree_list.`);
    if (source.primary) throw new Error("That is the primary worktree's own branch.");
    if (isDirty(source.path)) {
      throw new Error(`Worktree ${source.path} has uncommitted changes — commit them there first.`);
    }
    if (isDirty(primary.path)) {
      throw new Error(`The primary worktree has uncommitted changes — commit or stash them first.`);
    }
    if (!ctx.hasUI) {
      throw new Error("Merging needs the user's confirmation and no UI is available (fail-closed).");
    }

    const sourceBranch = source.branch ?? branch;
    const approved = await ctx.ui.confirm(
      "Merge worktree",
      `Merge branch "${sourceBranch}" into "${primary.branch ?? "the primary branch"}" and remove ${source.path}?`,
    );
    if (!approved) {
      return { text: "The user declined the merge.", branch: sourceBranch, removed: false, merged: false };
    }

    const merge = mergeBranch(primary.path, sourceBranch);
    if (!merge.ok) throw new Error(merge.message);

    const removal = removeWorktree(ctx.cwd, source.path, false);
    const cleanup = removal.ok
      ? `Worktree ${source.path} removed (branch kept).`
      : `Merge done, but removing the worktree failed: ${removal.output}`;
    return {
      text: `Merged "${sourceBranch}" into ${primary.branch ?? "primary"}.\n${cleanup}`,
      branch: sourceBranch,
      removed: removal.ok,
      merged: true,
    };
  }

  /**
   * Enter a worktree by forking this session into it. pi binds its built-in
   * tools to the session cwd and a session cannot change its own, so the only
   * way to take the conversation along is a replacement session.
   */
  async function enterWorktree(ctx: CommandContext, wanted: string, created = false): Promise<void> {
    requireRepo(ctx);
    if (typeof ctx.switchSession !== "function") {
      ctx.ui.notify("This pi build cannot switch sessions, so /worktree enter is unavailable.", "error");
      return;
    }

    const match = resolveWorktree(listWorktrees(ctx.cwd), wanted);
    const file = ctx.sessionManager.getSessionFile() ?? null;
    const plan = planEnter(
      ctx.cwd,
      { file, onDisk: Boolean(file && existsSync(file) && statSync(file).size > 0) },
      match ? { path: match.path, branch: match.branch } : null,
    );
    if ("kind" in plan) {
      ctx.ui.notify(plan.message, plan.kind === "already-here" ? "info" : "warning");
      return;
    }

    const state: WorktreeSession = {
      path: plan.target.path,
      branch: plan.target.branch,
      parentSession: plan.parentSession,
      created,
      enteredAt: Date.now(),
    };

    try {
      // forkFrom copies the conversation into a session file rooted at the
      // worktree; switching to it is what rebinds read/edit/bash and @.
      const replacement = SessionManager.forkFrom(plan.parentSession, state.path);
      const replacementFile = replacement.getSessionFile();
      if (!replacementFile) throw new Error("the forked session has no file");
      replacement.appendCustomEntry(WORKTREE_SESSION_ENTRY, state);
      const { cancelled } = await ctx.switchSession(replacementFile, {
        withSession: async (next) => {
          next.ui.notify(enteredNote(state), "info");
        },
      });
      if (cancelled) ctx.ui.notify("Staying put — the session switch was cancelled.", "info");
    } catch (err) {
      ctx.ui.notify(`Could not enter: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /** Return to the session this one was forked from. */
  async function exitWorktree(ctx: CommandContext): Promise<void> {
    const state = readWorktreeSession(ctx.sessionManager.getBranch() as never);
    if (!state) {
      ctx.ui.notify("This session was not entered with /worktree enter.", "warning");
      return;
    }
    if (!state.parentSession || !existsSync(state.parentSession)) {
      ctx.ui.notify(
        "The session this was forked from is gone, so there is nowhere to go back to. This session stays in the worktree.",
        "warning",
      );
      return;
    }
    try {
      await ctx.switchSession(state.parentSession, {
        withSession: async (next) => {
          next.ui.notify(exitNote(state), "info");
        },
      });
    } catch (err) {
      ctx.ui.notify(`Could not exit: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "worktree_list",
    label: "List worktrees",
    description:
      "List the repository's git worktrees with branch, dirty/locked/prunable state, and which one " +
      "is primary. Use before creating, removing, or merging.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      requireRepo(ctx as UiContext);
      return { content: [{ type: "text", text: listText(ctx as UiContext) }], details: {} };
    },
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Create worktree",
    description:
      "Create an isolated git worktree under ~/.worktrees/<repo>/ for parallel work that modifies " +
      "files. branch: a new branch (created from base, default HEAD) or an existing unoccupied local " +
      "branch. The main checkout stays untouched; report the returned path to the user so they can " +
      "open pi there.",
    parameters: Type.Object({
      branch: Type.String({ description: "Branch name (new or existing-unoccupied)" }),
      base: Type.Optional(Type.String({ description: "Base ref for a new branch (default HEAD)" })),
    }),
    async execute(_id, params: { branch: string; base?: string }, _signal, _onUpdate, ctx) {
      requireRepo(ctx as UiContext);
      const branch = params.branch.trim();
      if (!validBranchName(branch)) {
        throw new Error(`Invalid branch name ${JSON.stringify(params.branch)}.`);
      }
      if (params.base !== undefined && !validBranchName(params.base.trim()) && !/^[0-9a-f]{4,40}$/i.test(params.base.trim())) {
        throw new Error(`Invalid base ref ${JSON.stringify(params.base)}.`);
      }
      const result = createWorktree((ctx as UiContext).cwd, branch, params.base?.trim());
      if (!result.ok) throw new Error(result.message);
      return {
        content: [
          {
            type: "text",
            text: [
              `Worktree ready at ${result.path} (${result.message} base: ${result.base}).`,
              // Only the user can switch sessions, so tell them how rather than
              // implying this session moved.
              `Your tools still point at the main checkout. The user can run /worktree enter ${branch} to ` +
                `bring this conversation into the worktree, or open it separately with: cd "${result.path}" && pi`,
              `When the work is done: worktree_merge branch="${branch}" merges it back and cleans up.`,
            ].join("\n"),
          },
        ],
        details: { path: result.path, branch, createdBranch: result.createdBranch },
      };
    },
  });

  pi.registerTool({
    name: "worktree_remove",
    label: "Remove worktree",
    description:
      "Remove a worktree by branch name or path. Refuses the primary worktree, the one this session " +
      "runs in, and locked ones; uncommitted changes need the user's confirmation (denied when no UI). " +
      "The branch itself is kept.",
    parameters: Type.Object({
      target: Type.String({ description: "Branch name or worktree path" }),
    }),
    async execute(_id, params: { target: string }, _signal, _onUpdate, ctx) {
      const uiCtx = ctx as UiContext;
      requireRepo(uiCtx);
      const target = resolveTarget(uiCtx, params.target.trim());
      if (!target) throw new Error(`No worktree matches ${JSON.stringify(params.target)}. Use worktree_list.`);

      const dirty = isDirty(target.path);
      const risk = assessRemoval(target, uiCtx.cwd, dirty);

      if (!risk.ok && !risk.confirmable) {
        throw new Error(`Refusing to remove ${target.path}: ${risk.reasons.join("; ")}.`);
      }
      if (!risk.ok && risk.confirmable) {
        if (!uiCtx.hasUI) {
          throw new Error(
            `Refusing to remove ${target.path}: ${risk.reasons.join("; ")} (no UI to confirm — fail-closed).`,
          );
        }
        const approved = await uiCtx.ui.confirm(
          "Remove dirty worktree",
          `${target.path} has uncommitted changes that will be LOST. Remove anyway?`,
        );
        if (!approved) {
          return {
            content: [{ type: "text", text: "The user declined. Worktree kept." }],
            details: {},
          };
        }
      }

      const result = removeWorktree(uiCtx.cwd, target.path, dirty);
      if (!result.ok) throw new Error(result.output);
      return {
        content: [
          { type: "text", text: `Removed worktree ${target.path}. Branch "${target.branch ?? "(detached)"}" was kept.` },
        ],
        details: { path: target.path },
      };
    },
  });

  pi.registerTool({
    name: "worktree_merge",
    label: "Merge worktree",
    description:
      "Merge a worktree's branch into the primary worktree's current branch (with the user's " +
      "confirmation), then remove the worktree on success. Conflicting merges abort cleanly and " +
      "report — nothing is left half-merged.",
    parameters: Type.Object({
      branch: Type.String({ description: "Branch of the worktree to merge back" }),
    }),
    async execute(_id, params: { branch: string }, _signal, _onUpdate, ctx) {
      const result = await mergeWorktree(ctx as UiContext, params.branch);
      return {
        content: [{ type: "text", text: result.text }],
        details: { branch: result.branch, merged: result.merged, removed: result.removed },
      };
    },
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("worktree", {
    description:
      "Manage git worktrees: /worktree [create <branch> [base] [--enter] | enter <target> | exit | remove <target> | merge <branch> | prune]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const text = (args ?? "").trim();
      const route = (text.split(/\s+/)[0] ?? "").toLowerCase();
      // Keep the remainder whole: worktree paths contain spaces on Windows.
      const rest = text.slice(route.length).trim();
      try {
        requireRepo(ctx);
        switch (route || "list") {
          case "list": {
            ctx.ui.notify(listText(ctx), "info");
            return;
          }
          case "create": {
            const words = rest.split(/\s+/).filter(Boolean);
            const enterAfter = words.includes("--enter");
            const [arg, base] = words.filter((w) => w !== "--enter");
            if (!arg) {
              ctx.ui.notify("Usage: /worktree create <branch> [base] [--enter]", "warning");
              return;
            }
            if (!validBranchName(arg)) {
              ctx.ui.notify(`Invalid branch name "${arg}".`, "warning");
              return;
            }
            const result = createWorktree(ctx.cwd, arg, base);
            if (!result.ok) {
              ctx.ui.notify(result.message, "error");
              return;
            }
            if (enterAfter) {
              ctx.ui.notify(`Worktree ready: ${result.path}`, "info");
              await enterWorktree(ctx, arg, true);
              return;
            }
            ctx.ui.notify(
              `Worktree ready: ${result.path}\n` +
                `/worktree enter ${arg} takes this conversation there, or open it separately with: cd "${result.path}" && pi`,
              "info",
            );
            return;
          }
          case "remove": {
            if (!rest) {
              ctx.ui.notify("Usage: /worktree remove <branch|path>", "warning");
              return;
            }
            const target = resolveTarget(ctx, rest);
            if (!target) {
              ctx.ui.notify(`No worktree matches "${rest}".`, "warning");
              return;
            }
            const dirty = isDirty(target.path);
            const risk = assessRemoval(target, ctx.cwd, dirty);
            if (!risk.ok && !risk.confirmable) {
              ctx.ui.notify(`Cannot remove: ${risk.reasons.join("; ")}.`, "error");
              return;
            }
            if (dirty) {
              const approved = await ctx.ui.confirm(
                "Remove dirty worktree",
                `${target.path} has uncommitted changes that will be LOST. Remove anyway?`,
              );
              if (!approved) return;
            }
            const result = removeWorktree(ctx.cwd, target.path, dirty);
            ctx.ui.notify(result.ok ? `Removed ${target.path}.` : result.output, result.ok ? "info" : "error");
            return;
          }
          case "enter": {
            if (!rest) {
              ctx.ui.notify("Usage: /worktree enter <branch|path>", "warning");
              return;
            }
            await enterWorktree(ctx, rest);
            return;
          }
          case "exit": {
            await exitWorktree(ctx);
            return;
          }
          case "merge": {
            if (!rest) {
              ctx.ui.notify("Usage: /worktree merge <branch>", "warning");
              return;
            }
            const result = await mergeWorktree(ctx, rest);
            ctx.ui.notify(result.text, "info");
            return;
          }
          case "prune": {
            const result = pruneWorktrees(ctx.cwd);
            ctx.ui.notify(result.output || "Nothing to prune.", result.ok ? "info" : "error");
            return;
          }
          default:
            ctx.ui.notify(
              `Unknown route "${route}". Usage: /worktree [list | create <branch> [base] [--enter] | enter <target> | exit | remove <target> | merge <branch> | prune]`,
              "warning",
            );
        }
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
