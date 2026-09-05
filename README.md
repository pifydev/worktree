# @pify/worktree

Safe git-worktree management for [pi](https://github.com/earendil-works/pi) — isolated workspaces for parallel or risky changes, with safety rails everywhere and a clean merge-back flow. Windows-first: no tmux, no daemons, no shell interpolation.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install worktree`](https://github.com/pifydev/cli) or `pi install npm:@pify/worktree`.

## What it does

- **`worktree_create`** — new branch (or existing unoccupied one) checked out under `~/.worktrees/<repo>/<branch>`; reports the base commit and how to open pi there. The main checkout stays untouched.
- **`worktree_list`** — every worktree with branch, `primary`/`dirty`/`locked`/`prunable` flags.
- **`worktree_merge`** — with your confirmation: merges the worktree's branch into the primary branch, then removes the worktree. **Conflicting merges abort cleanly** — the primary is restored, nothing half-merged.
- **`worktree_remove`** — refuses the primary worktree, the one the session runs in, and locked ones outright; uncommitted changes need your explicit confirmation (fail-closed without a UI). The branch is always kept.
- **`/worktree`** — `list` / `create <branch> [base]` / `remove <target>` / `merge <branch>` / `prune` for humans. Everything after the route is taken whole, so paths with spaces work (v0.2).
- **Targets resolve the way you'd name them** (v0.2): a branch, a path, a directory name, or — for worktrees created by `isolation: "worktree"` in `@pify/subagent`/`swarm`/`workflow` — the agent slug alone (`worker-1` finds branch `agent/worker-1`).

## Safety model

Every git call is an `execFile` argv — no shell, no string interpolation, ever. Branch names are validated against a restricted grammar (no leading `-`, no `..`, no ref tricks) before reaching git. Removal risk is assessed (primary / current-session / locked / dirty) before anything happens — and containment is checked on directory boundaries (v0.2), so sitting in `feature-2` no longer blocks removing `feature`, and integration tests run the whole create→merge→remove and conflict-abort flows against real repositories.

## Where this sits in the suite

`@pify/subagent` and `@pify/swarm` run agents in-place (shared files — fine for read-mostly work). Worktrees are the isolation layer for parallel **mutating** work; spawning agents directly into worktrees is planned v0.2 integration across the three packages.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
