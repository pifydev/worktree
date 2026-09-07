# @pify/worktree

Safe git-worktree management for [pi](https://github.com/earendil-works/pi) — isolated workspaces for parallel or risky changes, with safety rails everywhere and a clean merge-back flow. Windows-first: no tmux, no daemons, no shell interpolation.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install worktree`](https://github.com/pifydev/cli) or `pi install npm:@pify/worktree`.

## What it does

- **`worktree_create`** — new branch (or existing unoccupied one) checked out under `~/.worktrees/<repo>/<branch>`; reports the base commit and how to open pi there. The main checkout stays untouched.
- **`worktree_list`** — every worktree with branch, `primary`/`dirty`/`locked`/`prunable` flags.
- **`worktree_merge`** — with your confirmation: merges the worktree's branch into the primary branch, then removes the worktree. **Conflicting merges abort cleanly** — the primary is restored, nothing half-merged.
- **`worktree_remove`** — refuses the primary worktree, the one the session runs in, and locked ones outright; uncommitted changes need your explicit confirmation (fail-closed without a UI). The branch is always kept.
- **`/worktree enter <target>` / `/worktree exit`** (v0.3) — take the conversation into a worktree and back out again. See below.
- **`/worktree`** — `list` / `create <branch> [base] [--enter]` / `enter <target>` / `exit` / `remove <target>` / `merge <branch>` / `prune` for humans. Everything after the route is taken whole, so paths with spaces work (v0.2).
- **Targets resolve the way you'd name them** (v0.2): a branch, a path, a directory name, or — for worktrees created by `isolation: "worktree"` in `@pify/subagent`/`swarm`/`workflow` — the agent slug alone (`worker-1` finds branch `agent/worker-1`).

## Entering a worktree (v0.3)

Creating a worktree used to be half the job. pi binds `read`, `edit`, `bash` and `@` completion to the session's working directory, and a session cannot change its own — so the worktree existed, and everything you had just discussed stayed in the terminal you were in.

`/worktree enter <branch|path>` forks the current session into the worktree and switches to it. The conversation comes along, the tools rebind, and the branch you were reading about is the branch you are now in. `/worktree exit` switches back to the session you came from; `/worktree create <branch> --enter` does both in one step.

Two things it will refuse, and why:

- **`--no-session`** — entering forks a session file, so there has to be one.
- **A session pi hasn't written yet** — pi keeps a session in memory until the agent has replied, so a brand-new session has nothing on disk to fork. Ask something first, or open the worktree in its own pi.

Only you can do this: session switching is a user command, so the agent cannot move itself. `worktree_create` says so in its result rather than implying the tools followed it.

The mechanism is [FradSer/pi-packages](https://github.com/FradSer/pi-packages)' — `utils` found it first.

## Safety model

Every git call is an `execFile` argv — no shell, no string interpolation, ever. Branch names are validated against a restricted grammar (no leading `-`, no `..`, no ref tricks) before reaching git. Removal risk is assessed (primary / current-session / locked / dirty) before anything happens — and containment is checked on directory boundaries (v0.2), so sitting in `feature-2` no longer blocks removing `feature`, and integration tests run the whole create→merge→remove and conflict-abort flows against real repositories.

## Where this sits in the suite

`@pify/subagent` and `@pify/swarm` run agents in-place (shared files — fine for read-mostly work). Worktrees are the isolation layer for parallel **mutating** work; spawning agents directly into worktrees is planned v0.2 integration across the three packages.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
