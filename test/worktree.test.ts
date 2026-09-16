import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assessRemoval,
  branchToDirName,
  isInside,
  resolveWorktree,
  formatWorktrees,
  parseWorktreeList,
  validBaseRef,
  validBranchName,
  type WorktreeInfo,
} from "../src/parse.ts";
import {
  createWorktree,
  failedAddCleanupPlan,
  gitLong,
  isDirty,
  listWorktrees,
  mergeBranch,
  removeWorktree,
} from "../src/git.ts";
import { runMerge } from "../src/merge.ts";

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

test("validBaseRef accepts refs/SHAs, rejects '-'-prefixed argv injection", () => {
  for (const ok of ["HEAD", "main", "origin/main", "release/v1.2.3", "  main  ", "0f1e2d3", "0123456789abcdef0123456789abcdef01234567"]) {
    assert.ok(validBaseRef(ok), ok);
  }
  // A leading '-' would be parsed by git as an OPTION (argument injection).
  for (const bad of ["--force", "-C", "-f", "--orphan", "- ", "sp ace", "a..b", ""]) {
    assert.ok(!validBaseRef(bad), bad);
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

test("create → list → dirty → merge → remove round-trip on a real repo", async () => {
  const repo = makeRepo();
  const created: string[] = [];
  try {
    const result = await createWorktree(repo, "feature-a");
    assert.ok(result.ok, result.message);
    assert.ok(result.createdBranch);
    created.push(result.path);

    const list = listWorktrees(repo);
    assert.equal(list.length, 2);
    assert.ok(list.some((w) => w.branch === "feature-a"));

    // occupied branch refuses a second worktree
    const dup = await createWorktree(repo, "feature-a");
    assert.ok(!dup.ok);
    assert.ok(dup.message.includes("already checked out"));

    // commit a change in the worktree, then merge it back
    writeFileSync(join(result.path, "new.txt"), "from worktree\n");
    assert.ok(isDirty(result.path));
    execFileSync("git", ["add", "."], { cwd: result.path, windowsHide: true });
    execFileSync("git", ["commit", "-m", "wt change"], { cwd: result.path, windowsHide: true });
    assert.ok(!isDirty(result.path));

    const merge = await mergeBranch(repo, "feature-a");
    assert.ok(merge.ok, merge.message);

    const removal = await removeWorktree(repo, result.path, false);
    assert.ok(removal.ok, removal.output);
    assert.equal(listWorktrees(repo).length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const p of created) rmSync(p, { recursive: true, force: true });
  }
});

test("create neutralizes a '-'-prefixed base ref (git argument injection)", async () => {
  const repo = makeRepo();
  const created: string[] = [];
  try {
    // Before the "--" separator, `git worktree add -b b <path> --force` parsed
    // "--force" as an OPTION and silently created the worktree. With "--" it is
    // read as a (nonexistent) ref, so git refuses and nothing is created.
    const result = await createWorktree(repo, "inject-branch", "--force");
    if (result.path) created.push(result.path);
    assert.ok(!result.ok, "a '-'-prefixed base ref must not create a worktree");
    assert.match(result.message, /invalid reference|unknown option|fatal/i);
    const list = listWorktrees(repo);
    assert.equal(list.length, 1, "no rogue worktree should exist");
    assert.ok(!list.some((w) => w.branch === "inject-branch"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const p of created) rmSync(p, { recursive: true, force: true });
  }
});

test("conflicting merge aborts cleanly", async () => {
  const repo = makeRepo();
  const created: string[] = [];
  try {
    const result = await createWorktree(repo, "conflict-branch");
    assert.ok(result.ok);
    created.push(result.path);

    // Diverge the same file in both worktrees.
    writeFileSync(join(result.path, "file.txt"), "worktree version\n");
    execFileSync("git", ["commit", "-am", "wt"], { cwd: result.path, windowsHide: true });
    writeFileSync(join(repo, "file.txt"), "main version\n");
    execFileSync("git", ["commit", "-am", "main"], { cwd: repo, windowsHide: true });

    const merge = await mergeBranch(repo, "conflict-branch");
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

// ── f176: nested-create path derives from the PRIMARY worktree ────────────

test("v0.3 creating from inside a worktree nests under the repo, not the linked branch", async () => {
  const repo = makeRepo();
  const created: string[] = [];
  try {
    const a = await createWorktree(repo, "feature-a");
    assert.ok(a.ok, a.message);
    created.push(a.path);

    // From INSIDE feature-a, rev-parse --show-toplevel returns feature-a's root,
    // so the pre-fix path would land in ~/.worktrees/feature-a/feature-b. The
    // primary lookup keeps it beside feature-a under ~/.worktrees/<repo>/.
    const b = await createWorktree(a.path, "feature-b");
    assert.ok(b.ok, b.message);
    created.push(b.path);
    assert.equal(dirname(b.path), dirname(a.path), `${b.path} should sit beside ${a.path}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const p of created) rmSync(p, { recursive: true, force: true });
  }
});

// ── f175: merging from inside the worktree keeps it ───────────────────────

function mergeDeps(overrides: Partial<Parameters<typeof runMerge>[3]> = {}) {
  const calls: string[] = [];
  const deps = {
    hasUI: true,
    isDirty: () => false,
    confirm: async (_t: string, m: string) => {
      calls.push(`confirm:${m}`);
      return true;
    },
    mergeBranch: async () => {
      calls.push("merge");
      return { ok: true, message: "" };
    },
    removeWorktree: async () => {
      calls.push("remove");
      return { ok: true, output: "" };
    },
    ...overrides,
  };
  return { calls, deps };
}

const MERGE_TREES = [
  info({ path: "/repo", branch: "main", primary: true }),
  info({ path: "/repo-wt/feature", branch: "feature" }),
];

test("v0.3 runMerge keeps the worktree when the session is rooted inside it", async () => {
  const { calls, deps } = mergeDeps();
  const outcome = await runMerge("/repo-wt/feature/src", MERGE_TREES, "feature", deps);
  assert.equal(outcome.merged, true);
  assert.equal(outcome.removed, false);
  assert.ok(calls.includes("merge"), "merge still happens");
  assert.ok(!calls.includes("remove"), "must not remove the worktree it is rooted in");
  assert.ok(calls.some((c) => c.startsWith("confirm:") && c.includes("keep")), "dialog says keep");
  assert.match(outcome.text, /\/worktree exit/);
});

test("v0.3 runMerge removes the worktree when merging from outside it", async () => {
  const { calls, deps } = mergeDeps();
  const outcome = await runMerge("/repo", MERGE_TREES, "feature", deps);
  assert.equal(outcome.merged, true);
  assert.equal(outcome.removed, true);
  assert.ok(calls.includes("remove"), "worktree removed when we are not inside it");
  assert.ok(calls.some((c) => c.startsWith("confirm:") && c.includes("remove")), "dialog says remove");
});

test("v0.3 runMerge declined leaves the worktree untouched", async () => {
  const { calls, deps } = mergeDeps({ confirm: async () => false });
  const outcome = await runMerge("/repo", MERGE_TREES, "feature", deps);
  assert.equal(outcome.merged, false);
  assert.ok(!calls.includes("merge") && !calls.includes("remove"));
});

// ── f178: long-op timeout plumbing and post-kill cleanup ──────────────────

test("v0.3 failedAddCleanupPlan unlocks before removing, prunes, and only deletes a created branch", () => {
  const created = failedAddCleanupPlan("/wt/x", "feat", true).map((s) => s.args.join(" "));
  assert.deepEqual(created, [
    "worktree unlock /wt/x",
    "worktree remove --force --force /wt/x",
    "worktree prune",
    "branch -D feat",
  ]);
  // An existing (pre-existing) branch must never be deleted by cleanup.
  const existing = failedAddCleanupPlan("/wt/x", "feat", false).map((s) => s.args[0] + " " + s.args[1]);
  assert.ok(!existing.some((c) => c === "branch -D"));
  assert.equal(existing.length, 3);
});

test("v0.3 gitLong flags an aborted call rather than throwing", async () => {
  const repo = makeRepo();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await gitLong(repo, ["status", "--porcelain"], { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("v0.3 createWorktree cleans up and reports when the add is aborted", async () => {
  const repo = makeRepo();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await createWorktree(repo, "aborted-feat", undefined, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.match(result.message, /cancelled/i);
    // Nothing should be left behind.
    assert.ok(!listWorktrees(repo).some((w) => w.branch === "aborted-feat"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
