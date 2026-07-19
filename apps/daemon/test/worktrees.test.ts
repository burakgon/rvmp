import { test, expect, beforeAll } from "bun:test";
import { openDb } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { createWorktree, listWorktrees, archiveWorktree } from "../src/git/worktrees";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sh = async (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};

let repo: string;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "cg-repo-"));
  await sh(repo, "git", "init", "-b", "main");
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.txt"), "hello");
  await sh(repo, "git", "add", "-A");
  await sh(repo, "git", "commit", "-m", "init");
});

test("create, list, archive worktree", async () => {
  const db = openDb(":memory:");
  const project = createProject(db, { name: "R", path: repo, baseBranch: "main" });
  const wt = await createWorktree(db, project, { cardId: 7, slugSource: "Fix Stripe webhook retries" });
  expect(wt.branch).toBe("cg/7-fix-stripe-webhook-retries");
  expect(await Bun.file(join(wt.path, "a.txt")).exists()).toBe(true);
  expect(listWorktrees(db, project.id).length).toBe(1);
  await archiveWorktree(db, project, wt.id);
  expect(listWorktrees(db, project.id)[0].state).toBe("archived");
  expect(await Bun.file(join(wt.path, "a.txt")).exists()).toBe(false);
}, 20000);
