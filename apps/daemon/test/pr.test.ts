import { test, expect } from "bun:test";
import { ciFromRollup, createPr, ghAvailable, viewPr, type CommandRunner } from "../src/git/pr";

// Scripted runner: matches command prefixes, records every call.
type Rule = { starts: string[]; code?: number; stdout?: string; stderr?: string };
function scripted(rules: Rule[]): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (_cwd, cmd) => {
    calls.push(cmd);
    const hit = rules.find((r) => r.starts.every((tok, i) => cmd[i] === tok));
    return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
  };
  return { run, calls };
}

const VIEW_OPEN = JSON.stringify({
  number: 7, url: "https://github.com/x/y/pull/7", state: "OPEN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
});

test("ghAvailable distinguishes no-gh / no-remote / not-authed / ok", async () => {
  const noGh = scripted([{ starts: ["gh", "--version"], code: 127 }]);
  expect(await ghAvailable(noGh.run, "/r")).toEqual({ ok: false, reason: "no-gh" });

  const noRemote = scripted([
    { starts: ["gh", "--version"] },
    { starts: ["git", "remote"], code: 2 },
  ]);
  expect(await ghAvailable(noRemote.run, "/r")).toEqual({ ok: false, reason: "no-remote" });

  const notAuthed = scripted([
    { starts: ["gh", "--version"] },
    { starts: ["git", "remote"], stdout: "git@github.com:x/y.git" },
    { starts: ["gh", "auth"], code: 1 },
  ]);
  expect(await ghAvailable(notAuthed.run, "/r")).toEqual({ ok: false, reason: "not-authed" });

  const ok = scripted([
    { starts: ["gh", "--version"] },
    { starts: ["git", "remote"], stdout: "git@github.com:x/y.git" },
    { starts: ["gh", "auth"] },
  ]);
  expect(await ghAvailable(ok.run, "/r")).toEqual({ ok: true });
});

test("createPr pushes, creates, then views — and surfaces push failure", async () => {
  const s = scripted([
    { starts: ["git", "push"] },
    { starts: ["gh", "pr", "create"], stdout: "https://github.com/x/y/pull/7\n" },
    { starts: ["gh", "pr", "view"], stdout: VIEW_OPEN },
  ]);
  const info = await createPr(s.run, "/r", { title: "T", body: "B", base: "main", head: "cg/1-t" });
  expect(info).toEqual({ number: 7, url: "https://github.com/x/y/pull/7", state: "open", ci: "pass" });
  expect(s.calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
    "git push -u", "gh pr create", "gh pr view",
  ]);

  const bad = scripted([{ starts: ["git", "push"], code: 1, stderr: "no access" }]);
  await expect(createPr(bad.run, "/r", { title: "T", body: "B", base: "main", head: "h" }))
    .rejects.toThrow(/push failed: no access/);
});

test("viewPr maps gh states; ciFromRollup collapses check truth", async () => {
  const merged = scripted([{
    starts: ["gh", "pr", "view"],
    stdout: JSON.stringify({ number: 7, url: "u", state: "MERGED", statusCheckRollup: [] }),
  }]);
  expect((await viewPr(merged.run, "/r", 7)).state).toBe("merged");
  expect((await viewPr(merged.run, "/r", 7)).ci).toBeNull(); // no checks → null, not pass

  expect(ciFromRollup(null)).toBeNull();
  expect(ciFromRollup([{ status: "COMPLETED", conclusion: "FAILURE" }])).toBe("fail");
  expect(ciFromRollup([{ state: "ERROR" }])).toBe("fail");
  expect(ciFromRollup([{ status: "IN_PROGRESS", conclusion: "" }])).toBe("pending");
  expect(ciFromRollup([{ state: "PENDING" }])).toBe("pending");
  expect(ciFromRollup([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { state: "SUCCESS" },
  ])).toBe("pass");
  // one failure outranks everything else
  expect(ciFromRollup([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "IN_PROGRESS" },
    { conclusion: "FAILURE", status: "COMPLETED" },
  ])).toBe("fail");
});
