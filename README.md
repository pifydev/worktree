# @pify/worktree

Safe git-worktree management for [pi](https://github.com/earendil-works/pi) — isolated workspaces for parallel or risky changes, with safety rails on every destructive path and a clean merge-back flow. Windows-first: no tmux, no daemons, no shell interpolation.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install worktree`](https://github.com/pifydev/cli) or `pi install npm:@pify/worktree`.

## Why

Two changes that touch the same files cannot share one checkout. The usual workarounds — stashing, branching back and forth, or just being careful — all fail the same way: work gets lost, or the main checkout ends up in a state nobody can build. A worktree gives each line of work its own directory and its own branch, and git already knows how to do it. What was missing was a way to drive it that refuses to destroy anything by accident, and a way to actually *go there* without abandoning the conversation.

## Tools

### `worktree_create`

| Parameter | Type | Notes |
|---|---|---|
| `branch` | string | A new branch, or an existing one not checked out anywhere |
| `base` | string, optional | Base ref for a new branch; defaults to HEAD |

Creates the worktree under `~/.worktrees/<repo>/<branch>` and reports the path and base commit. The main checkout is untouched. The result also says plainly that the agent's own tools still point at the main checkout — only you can move the session (see below).

### `worktree_list`

No parameters. Every worktree with its branch and `primary` / `dirty` / `locked` / `prunable` flags.

### `worktree_merge`

| Parameter | Type | Notes |
|---|---|---|
| `branch` | string | Branch of the worktree to merge back |

With your confirmation: merges into the primary worktree's branch, then removes the worktree (keeping the branch). Both sides must be clean first. **A conflicting merge aborts cleanly** — the primary is restored and nothing is left half-merged.

### `worktree_remove`

| Parameter | Type | Notes |
|---|---|---|
| `target` | string | Branch name or worktree path |

Refuses the primary worktree, the one this session runs in, and locked ones outright. Uncommitted changes require your explicit confirmation, and are refused outright when there is no UI to ask through. The branch itself is always kept.

## Entering a worktree

Creating a worktree used to be half the job. pi binds `read`, `edit`, `bash` and `@` completion to the session's working directory, and a session cannot change its own — so the worktree existed, and everything you had just discussed stayed in the terminal you were in.

`/worktree enter <branch|path>` forks the current session into the worktree and switches to it. The conversation comes along, the tools rebind, and the branch you were reading about is the branch you are now in. `/worktree exit` returns to the session you came from. `/worktree create <branch> --enter` does both in one step.

Two refusals, each with a different fix:

- **`--no-session`** — entering forks a session file, so there has to be one.
- **A session pi has not written yet** — pi keeps a session in memory until the agent has replied, so a brand-new session has nothing on disk to fork. Ask something first, or open the worktree in its own pi.

Session switching is a user command, so **the agent cannot move itself**. That is why `worktree_create` says so in its result instead of implying the tools followed it there.

## Command

`/worktree` — the same list as `worktree_list`.
`/worktree create <branch> [base] [--enter]` — create, optionally entering it.
`/worktree enter <branch|path>` — take the conversation into a worktree.
`/worktree exit` — return to the session you came from.
`/worktree remove <branch|path>` — remove, with the same rails as the tool.
`/worktree merge <branch>` — merge back and clean up.
`/worktree prune` — drop administrative records for worktrees whose directories are gone.

Everything after the route is taken whole, so paths with spaces work.

## Targets resolve the way you would name them

A branch, a full path, a directory name — or, for worktrees created by `isolation: "worktree"` in [`@pify/subagent`](https://github.com/pifydev/subagent), [`@pify/swarm`](https://github.com/pifydev/swarm) or [`@pify/workflow`](https://github.com/pifydev/workflow), the agent slug alone: `worker-1` finds branch `agent/worker-1`.

## Safety model

Every git call is an `execFile` argv — no shell, no string interpolation, ever. Branch names are validated against a restricted grammar (no leading `-`, no `..`, no ref tricks) before they reach git.

Removal risk is assessed before anything happens: primary, current-session, locked, and dirty are four distinct verdicts, and only dirty is confirmable. Containment is checked on directory boundaries, so sitting in `feature-2` does not block removing `feature`.

Integration tests run the whole create → merge → remove flow, and the conflict-abort path, against real repositories rather than mocks.

## Where this sits in the suite

`@pify/subagent` and `@pify/swarm` run agents in place — shared files, which is fine for read-mostly work. Worktrees are the isolation layer for parallel **mutating** work, and all three of the agent packages can create one per child with `isolation: "worktree"`. A worktree whose child changed nothing is removed automatically; anything uncommitted is kept and reported.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
