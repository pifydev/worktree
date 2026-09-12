/**
 * Does forking a session into a worktree actually re-root it?
 *
 * `/worktree enter` rests on one assumption: `SessionManager.forkFrom(source,
 * worktreePath)` produces a session whose cwd is the worktree and whose
 * conversation is the one we were having. If either half is false the command
 * silently loses your work, so this drives the real pi SessionManager against
 * a real git worktree. No model and no API key — it is the session layer, not
 * the agent, that is under test.
 *
 *   bun run test/live/fork.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { WORKTREE_SESSION_ENTRY, readWorktreeSession } from "../../src/enter.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const same = (a, b) => a.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() ===
  b.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const root = mkdtempSync(join(tmpdir(), "pify-wt-fork-"));
const repo = join(root, "repo");
const sessions = join(root, "sessions");

try {
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");

  const worktree = join(root, "repo-wt", "feature");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

  // A session in the main checkout, with something in it worth keeping.
  const parent = SessionManager.create(repo, sessions);
  parent.appendMessage({ role: "user", content: "remember the number 41724" });
  // pi holds a session in memory until the agent replies; only then is there a
  // file to fork. /worktree enter refuses before this point for the same reason.
  parent.appendMessage({ role: "assistant", content: "noted" });
  const parentFile = parent.getSessionFile();
  check("the parent session has a file", Boolean(parentFile), parentFile ?? "none");

  // The move /worktree enter makes.
  const forked = SessionManager.forkFrom(parentFile, worktree, sessions);
  const state = {
    path: worktree,
    branch: "feature",
    parentSession: parentFile,
    created: true,
    enteredAt: 1,
  };
  forked.appendCustomEntry(WORKTREE_SESSION_ENTRY, state);
  const forkedFile = forked.getSessionFile();

  check("the fork is a different session file", forkedFile !== parentFile, forkedFile ?? "none");
  check("the fork is rooted in the worktree", same(forked.getCwd(), worktree), forked.getCwd());
  check("the parent stayed where it was", same(parent.getCwd(), repo), parent.getCwd());

  const carried = forked
    .getBranch()
    .some((e) => JSON.stringify(e).includes("41724"));
  check("the conversation came along", carried);

  const readBack = readWorktreeSession(forked.getBranch());
  check("the worktree state is readable back", readBack?.path === worktree, readBack?.path ?? "none");
  check("exit knows where to return to", readBack?.parentSession === parentFile);
  check("exit knows the worktree was created by entering", readBack?.created === true);

  // Reopening from disk is what pi does on switchSession.
  const reopened = SessionManager.open(forkedFile);
  check("reopening the file still gives the worktree cwd", same(reopened.getCwd(), worktree), reopened.getCwd());
  check(
    "reopening the file still finds the worktree state",
    readWorktreeSession(reopened.getBranch())?.path === worktree,
  );
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exitCode = failed === 0 ? 0 : 1;
