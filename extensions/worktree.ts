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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { assessRemoval, formatWorktrees, validBranchName } from "../src/parse.ts";

type UiContext = ExtensionContext;

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
    const worktrees = listWorktrees(ctx.cwd);
    const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    return worktrees.find(
      (w) => w.branch === target || norm(w.path) === norm(target),
    );
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
              `Open a pi session there with: cd "${result.path}" && pi`,
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
      const uiCtx = ctx as UiContext;
      requireRepo(uiCtx);
      const branch = params.branch.trim();
      if (!validBranchName(branch)) throw new Error(`Invalid branch name ${JSON.stringify(params.branch)}.`);

      const worktrees = listWorktrees(uiCtx.cwd);
      const primary = worktrees.find((w) => w.primary);
      const source = worktrees.find((w) => w.branch === branch);
      if (!primary) throw new Error("Could not locate the primary worktree.");
      if (!source) throw new Error(`No worktree has branch "${branch}". Use worktree_list.`);
      if (source.primary) throw new Error("That is the primary worktree's own branch.");
      if (isDirty(source.path)) {
        throw new Error(`Worktree ${source.path} has uncommitted changes — commit them there first.`);
      }
      if (isDirty(primary.path)) {
        throw new Error(`The primary worktree has uncommitted changes — commit or stash them first.`);
      }

      if (!uiCtx.hasUI) {
        throw new Error("Merging needs the user's confirmation and no UI is available (fail-closed).");
      }
      const approved = await uiCtx.ui.confirm(
        "Merge worktree",
        `Merge branch "${branch}" into "${primary.branch ?? "the primary branch"}" and remove ${source.path}?`,
      );
      if (!approved) {
        return { content: [{ type: "text", text: "The user declined the merge." }], details: {} };
      }

      const merge = mergeBranch(primary.path, branch);
      if (!merge.ok) throw new Error(merge.message);

      const removal = removeWorktree(uiCtx.cwd, source.path, false);
      const cleanup = removal.ok
        ? `Worktree ${source.path} removed (branch kept).`
        : `Merge done, but removing the worktree failed: ${removal.output}`;
      return {
        content: [{ type: "text", text: `Merged "${branch}" into ${primary.branch ?? "primary"}.\n${cleanup}` }],
        details: { branch, removed: removal.ok },
      };
    },
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("worktree", {
    description: "Manage git worktrees: /worktree [create <branch> | remove <target> | prune]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const [route, arg] = (args ?? "").trim().split(/\s+/);
      try {
        requireRepo(ctx);
        switch ((route || "list").toLowerCase()) {
          case "list": {
            ctx.ui.notify(listText(ctx), "info");
            return;
          }
          case "create": {
            if (!arg || !validBranchName(arg)) {
              ctx.ui.notify("Usage: /worktree create <branch>", "warning");
              return;
            }
            const result = createWorktree(ctx.cwd, arg);
            ctx.ui.notify(
              result.ok ? `Worktree ready: ${result.path}\nOpen with: cd "${result.path}" && pi` : result.message,
              result.ok ? "info" : "error",
            );
            return;
          }
          case "remove": {
            if (!arg) {
              ctx.ui.notify("Usage: /worktree remove <branch|path>", "warning");
              return;
            }
            const target = resolveTarget(ctx, arg);
            if (!target) {
              ctx.ui.notify(`No worktree matches "${arg}".`, "warning");
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
          case "prune": {
            const result = pruneWorktrees(ctx.cwd);
            ctx.ui.notify(result.output || "Nothing to prune.", result.ok ? "info" : "error");
            return;
          }
          default:
            ctx.ui.notify("Usage: /worktree [create <branch> | remove <target> | prune]", "warning");
        }
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
