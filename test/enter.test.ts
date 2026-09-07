import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKTREE_SESSION_ENTRY,
  enteredNote,
  exitNote,
  planEnter,
  readWorktreeSession,
} from "../src/enter.ts";

const entry = (data: unknown) => ({ type: "custom", customType: WORKTREE_SESSION_ENTRY, data });

test("entering needs a persisted session, a target, and somewhere else to go", () => {
  const target = { path: "D:/repo-wt/feature", branch: "feature" };

  const saved = { file: "D:/s.jsonl", onDisk: true };

  const noSession = planEnter("D:/repo", { file: null, onDisk: false }, target);
  assert.equal("kind" in noSession && noSession.kind, "no-session");
  assert.match((noSession as { message: string }).message, /--no-session/);

  // pi keeps a session in memory until the agent replies; forking that file throws.
  const unwritten = planEnter("D:/repo", { file: "D:/s.jsonl", onDisk: false }, target);
  assert.equal("kind" in unwritten && unwritten.kind, "unwritten");
  assert.match((unwritten as { message: string }).message, /not been written/);

  const missing = planEnter("D:/repo", saved, null);
  assert.equal("kind" in missing && missing.kind, "not-found");
  assert.match((missing as { message: string }).message, /worktree create/);

  const here = planEnter("D:/repo-wt/feature", saved, target);
  assert.equal("kind" in here && here.kind, "already-here");

  const ok = planEnter("D:/repo", saved, target);
  assert.deepEqual(ok, { target, parentSession: "D:/s.jsonl" });
});

test("already-here survives separator and trailing-slash differences", () => {
  // git reports forward slashes; ctx.cwd on Windows does not.
  const target = { path: "D:/repo-wt/feature", branch: "feature" };
  for (const cwd of ["D:\\repo-wt\\feature", "D:/repo-wt/feature/", "D:\\Repo-WT\\Feature"]) {
    const plan = planEnter(cwd, { file: "D:/s.jsonl", onDisk: true }, target);
    assert.equal("kind" in plan && plan.kind, "already-here", cwd);
  }
});

test("the session's worktree state is the last one written", () => {
  const state = readWorktreeSession([
    { type: "message" },
    entry({ path: "D:/a", branch: "a", parentSession: "D:/s1.jsonl", created: false, enteredAt: 1 }),
    entry({ path: "D:/b", branch: "b", parentSession: "D:/s2.jsonl", created: true, enteredAt: 2 }),
  ]);
  assert.equal(state?.path, "D:/b");
  assert.equal(state?.created, true);
  assert.equal(state?.parentSession, "D:/s2.jsonl");
});

test("a session that never entered a worktree has no state", () => {
  assert.equal(readWorktreeSession([]), null);
  assert.equal(readWorktreeSession([{ type: "custom", customType: "something-else", data: { path: "D:/a" } }]), null);
  // Malformed entries are ignored rather than trusted.
  assert.equal(readWorktreeSession([entry({ branch: "a" }), entry(null)]), null);
});

test("notes say where you are and how to get back", () => {
  const state = {
    path: "D:/repo-wt/feature",
    branch: "feature",
    parentSession: "D:/s.jsonl",
    created: true,
    enteredAt: 0,
  };
  const entered = enteredNote(state);
  assert.match(entered, /D:\/repo-wt\/feature/);
  assert.match(entered, /on feature/);
  assert.match(entered, /\/worktree exit/);

  // Leaving a worktree entering created must not imply it was cleaned up.
  assert.match(exitNote(state), /still there/);
  assert.match(exitNote({ ...state, created: false }), /untouched/);
});
