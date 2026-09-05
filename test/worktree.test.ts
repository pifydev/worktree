import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessRemoval,
  branchToDirName,
  isInside,
  resolveWorktree,
  formatWorktrees,
  parseWorktreeList,
  validBranchName,
  type WorktreeInfo,
} from "../src/parse.ts";
import { createWorktree, isDirty, listWorktrees, mergeBranch, removeWorktree } from "../src/git.ts";

// ── Pure parsing/validation ──────────────────────────────────────────────

const PORCELAIN = `worktree /repo/main
HEAD 1234567890abcdef1234567890abcdef12345678
branch refs/heads/main

worktree /repo/wt-feature
HEAD abcdef1234567890abcdef1234567890abcdef12
branch refs/heads/feature/x
locked

worktree /repo/wt-detached
HEAD fedcba0987654321fedcba0987654321fedcba09
detached
prunable gitdir file points to non-existent location
`;

test("parseWorktreeList parses branches, flags, and primary", () => {
  const list = parseWorktreeList(PORCELAIN);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], {
    path: "/repo/main",
    head: "1234567890abcdef1234567890abcdef12345678",
    branch: "main",
    detached: false,
    locked: false,
    prunable: false,
    primary: true,
  });
  assert.equal(list[1]!.branch, "feature/x");
  assert.equal(list[1]!.locked, true);
  assert.equal(list[1]!.primary, false);
  assert.equal(list[2]!.detached, true);
  assert.equal(list[2]!.prunable, true);
  assert.deepEqual(parseWorktreeList(""), []);
});

test("validBranchName accepts sane names, rejects tricks", () => {
  for (const ok of ["main", "feature/login", "fix-123", "release/v1.2.3", "a.b_c"]) {
    assert.ok(validBranchName(ok), ok);
  }
  for (const bad of ["-rf", "/abs", "trailing/", "a..b", "a//b", "x.lock", "@", "a@{b}", "sp ace", "semi;colon", ""]) {
    assert.ok(!validBranchName(bad), bad);
  }
});

test("branchToDirName flattens slashes", () => {
  assert.equal(branchToDirName("feature/login"), "feature-login");
  assert.equal(branchToDirName("weird name!"), "weird_name_");
});

function info(overrides: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: "/repo/wt",
    head: "abc",
    branch: "feature",
    detached: false,
    locked: false,
    prunable: false,
    primary: false,
    ...overrides,
  };
}

test("assessRemoval: hard refusals vs confirmable dirty", () => {
  assert.deepEqual(assessRemoval(info({}), "/elsewhere", false), { ok: true, reasons: [], confirmable: false });
  const primary = assessRemoval(info({ primary: true }), "/elsewhere", false);
  assert.ok(!primary.ok && !primary.confirmable);
  const inside = assessRemoval(info({ path: "/repo/wt" }), "/repo/wt/sub/dir", false);
  assert.ok(!inside.ok && inside.reasons.some((r) => r.includes("running inside")));
  const locked = assessRemoval(info({ locked: true }), "/elsewhere", true);
  assert.ok(!locked.ok && !locked.confirmable);
  const dirty = assessRemoval(info({}), "/elsewhere", true);
  assert.ok(!dirty.ok && dirty.confirmable);
});

test("formatWorktrees renders flags", () => {
  const text = formatWorktrees(parseWorktreeList(PORCELAIN), new Set(["/repo/wt-feature"]));
  assert.ok(text.includes("primary"));
  assert.ok(text.includes("locked, dirty") || text.includes("dirty"));
  assert.ok(text.includes("feature/x"));
  assert.equal(formatWorktrees([], new Set()), "No worktrees.");
});

// ── Integration against a real git repo ──────────────────────────────────

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pify-wt-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  run("init", "-b", "main");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "file.txt"), "one\n");
  run("add", ".");
  run("commit", "-m", "init");
  return dir;
}

test("create → list → dirty → merge → remove round-trip on a real repo", () => {
  const repo = makeRepo();
  const created: string[] = [];
  try {
    const result = createWorktree(repo, "feature-a");
    assert.ok(result.ok, result.message);
    assert.ok(result.createdBranch);
    created.push(result.path);

    const list = listWorktrees(repo);
    assert.equal(list.length, 2);
    assert.ok(list.some((w) => w.branch === "feature-a"));

    // occupied branch refuses a second worktree
    const dup = createWorktree(repo, "feature-a");
    assert.ok(!dup.ok);
    assert.ok(dup.message.includes("already checked out"));

    // commit a change in the worktree, then merge it back
    writeFileSync(join(result.path, "new.txt"), "from worktree\n");
    assert.ok(isDirty(result.path));
    execFileSync("git", ["add", "."], { cwd: result.path, windowsHide: true });
    execFileSync("git", ["commit", "-m", "wt change"], { cwd: result.path, windowsHide: true });
    assert.ok(!isDirty(result.path));

    const merge = mergeBranch(repo, "feature-a");
    assert.ok(merge.ok, merge.message);

    const removal = removeWorktree(repo, result.path, false);
    assert.ok(removal.ok, removal.output);
    assert.equal(listWorktrees(repo).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const p of created) rmSync(p, { recursive: true, force: true });
  }
});

test("conflicting merge aborts cleanly", () => {
  const repo = makeRepo();
  const created: string[] = [];
  try {
    const result = createWorktree(repo, "conflict-branch");
    assert.ok(result.ok);
    created.push(result.path);

    // Diverge the same file in both worktrees.
    writeFileSync(join(result.path, "file.txt"), "worktree version\n");
    execFileSync("git", ["commit", "-am", "wt"], { cwd: result.path, windowsHide: true });
    writeFileSync(join(repo, "file.txt"), "main version\n");
    execFileSync("git", ["commit", "-am", "main"], { cwd: repo, windowsHide: true });

    const merge = mergeBranch(repo, "conflict-branch");
    assert.ok(!merge.ok);
    assert.ok(merge.message.includes("aborted"));
    assert.ok(!isDirty(repo), "primary restored to clean state");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const p of created) rmSync(p, { recursive: true, force: true });
  }
});

test("v0.2 isInside respects directory boundaries", () => {
  assert.equal(isInside("/repo/wt", "/repo/wt"), true);
  assert.equal(isInside("/repo/wt/sub/dir", "/repo/wt"), true);
  assert.equal(isInside("/repo/wt/", "/repo/wt"), true);
  // the sibling case worktree generation actually produces
  assert.equal(isInside("/repo/feature-2", "/repo/feature"), false);
  assert.equal(isInside("/repo/other", "/repo/wt"), false);
  // Windows paths and case
  assert.equal(isInside("C:\\Users\\a\\.worktrees\\repo\\x\\src", "C:/Users/A/.worktrees/repo/x"), true);
});

test("v0.2 a sibling worktree is removable", () => {
  const target = info({ path: "/repo/feature" });
  const risk = assessRemoval(target, "/repo/feature-2", false);
  assert.deepEqual(risk, { ok: true, reasons: [], confirmable: false });
});

test("v0.2 resolveWorktree matches branch, namespace, path, and dir name", () => {
  const trees = [
    info({ path: "/repo", branch: "main", primary: true }),
    info({ path: "C:/Users/a/.worktrees/repo/worker-1", branch: "agent/worker-1" }),
    info({ path: "/repo/wt-feature", branch: "feature/x" }),
  ];
  assert.equal(resolveWorktree(trees, "feature/x")!.path, "/repo/wt-feature");
  // isolate.ts names branches agent/<slug>; the slug alone should find it
  assert.equal(resolveWorktree(trees, "worker-1")!.branch, "agent/worker-1");
  assert.equal(resolveWorktree(trees, "agent/worker-1")!.branch, "agent/worker-1");
  assert.equal(resolveWorktree(trees, "c:\\users\\a\\.worktrees\\repo\\worker-1")!.branch, "agent/worker-1");
  assert.equal(resolveWorktree(trees, "wt-feature")!.branch, "feature/x");
  assert.equal(resolveWorktree(trees, "nope"), null);
  assert.equal(resolveWorktree(trees, "  "), null);
});
