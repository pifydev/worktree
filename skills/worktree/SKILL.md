---
name: worktree
description: Use when work should happen in isolation from the main checkout - risky refactors, parallel efforts, or long-running changes - explains the worktree tools, safety rails, and the merge-back flow
---

# Git worktrees

This project has the `@pify/worktree` extension installed: create isolated
worktrees for work that modifies files without touching the main checkout.

## When to use

- A risky or large change the user may want to abandon cleanly.
- Parallel efforts on the same repo (each gets its own worktree + branch).
- Keeping the main checkout buildable while something long-running proceeds.

Not for read-only exploration (subagents already read in place) or trivial
edits.

## The flow

1. `worktree_list` — see what exists (primary, dirty, locked flags).
2. `worktree_create branch="feature-x"` — new branch from HEAD (or pass
   `base`), checked out under `~/.worktrees/<repo>/`. Tell the user the
   path — they can run pi there (`cd <path> && pi`).
3. Work happens in the worktree; commit there.
4. `worktree_merge branch="feature-x"` — asks the user, merges into the
   primary branch, removes the worktree. Conflicts abort cleanly; nothing
   is left half-merged.
5. `worktree_remove target="feature-x"` — abandon instead; dirty worktrees
   need the user's confirmation, the branch is always kept.

## Rules

- Never try to bypass a refusal (primary/current/locked worktrees).
- Commit inside the worktree before merging — both sides must be clean.
- One branch per worktree; a branch already checked out elsewhere refuses.
