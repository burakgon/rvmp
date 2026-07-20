import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aheadBehind, computeDiff, computeDiffSummary } from "../src/git/diff";

// Real fixture repo: seed on main → work branch with one of each change kind →
// main advances past the branch point (three-dot isolation must hide it).
const run = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};

let repo: string;
const BRANCH = "cg/1-test";

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "cg-diff-"));
  await run(repo, "init", "-b", "main");
  await run(repo, "config", "user.email", "t@example.com");
  await run(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
  writeFileSync(join(repo, "b.txt"), "bye\n");
  writeFileSync(join(repo, "c.txt"), "stable rename payload\nsecond line\n");
  await run(repo, "add", ".");
  await run(repo, "commit", "-m", "seed");

  await run(repo, "checkout", "-b", BRANCH);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nTHREE\nfour\nfive\n"); // M
  writeFileSync(join(repo, "new.txt"), "fresh\n"); // A
  rmSync(join(repo, "b.txt")); // D
  renameSync(join(repo, "c.txt"), join(repo, "d.txt")); // R100
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 0, 255])); // A binary
  await run(repo, "add", "-A");
  await run(repo, "commit", "-m", "work");

  // base moves on AFTER the branch point — must not leak into the card's diff
  await run(repo, "checkout", "main");
  writeFileSync(join(repo, "base-only.txt"), "advance\n");
  await run(repo, "add", ".");
  await run(repo, "commit", "-m", "advance");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("computeDiff: statuses, rename, binary, totals, three-dot isolation", async () => {
  const d = await computeDiff(repo, "main", BRANCH);
  expect(d.branch).toBe(BRANCH);
  expect(d.base).toBe("main");
  const by = Object.fromEntries(d.files.map(f => [f.path, f]));

  expect(by["a.txt"]).toMatchObject({ status: "M", additions: 1, deletions: 1, binary: false, oldPath: null });
  expect(by["new.txt"]).toMatchObject({ status: "A", additions: 1, deletions: 0 });
  expect(by["b.txt"]).toMatchObject({ status: "D", additions: 0, deletions: 1 });
  expect(by["d.txt"]).toMatchObject({ status: "R", oldPath: "c.txt", additions: 0, deletions: 0 });
  expect(by["d.txt"]!.hunks).toEqual([]); // pure rename: no content hunks
  expect(by["bin.dat"]).toMatchObject({ status: "A", binary: true, additions: 0, deletions: 0 });
  expect(by["bin.dat"]!.hunks).toEqual([]);

  expect(by["base-only.txt"]).toBeUndefined(); // the base's own commit stays out
  expect(d.additions).toBe(2);
  expect(d.deletions).toBe(2);
});

test("computeDiff: hunk line numbering", async () => {
  const d = await computeDiff(repo, "main", BRANCH);
  const a = d.files.find(f => f.path === "a.txt")!;
  expect(a.hunks.length).toBe(1);
  const lines = a.hunks[0]!.lines;
  const del = lines.find(l => l.t === "del")!;
  const add = lines.find(l => l.t === "add")!;
  expect(del).toMatchObject({ text: "three", oldNo: 3, newNo: null });
  expect(add).toMatchObject({ text: "THREE", oldNo: null, newNo: 3 });
  const firstCtx = lines.find(l => l.t === "ctx")!;
  expect(firstCtx).toMatchObject({ oldNo: 1, newNo: 1 }); // context counts both sides
});

test("computeDiff: oversize file flags truncated and drops hunks (binary untouched)", async () => {
  const d = await computeDiff(repo, "main", BRANCH, { maxFileBytes: 10 });
  const a = d.files.find(f => f.path === "a.txt")!;
  expect(a.truncated).toBe(true);
  expect(a.hunks).toEqual([]);
  expect(a.additions).toBe(1); // stats survive truncation
  const bin = d.files.find(f => f.path === "bin.dat")!;
  expect(bin.binary).toBe(true);
  expect(bin.truncated).toBe(false); // binary is binary, not "too large"
});

test("computeDiffSummary matches the full payload math", async () => {
  const s = await computeDiffSummary(repo, "main", BRANCH);
  expect(s).toEqual({ files: 5, additions: 2, deletions: 2 });
});

test("aheadBehind counts both directions", async () => {
  expect(await aheadBehind(repo, "main", BRANCH)).toEqual({ ahead: 1, behind: 1 });
  expect(await aheadBehind(repo, "main", "main")).toEqual({ ahead: 0, behind: 0 });
});
