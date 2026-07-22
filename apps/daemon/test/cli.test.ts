import { test, expect, describe, afterAll } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorReport, findDaemon, parseCli, restoreDatabase, taskAdd } from "../src/cli";
import { openDb } from "../src/store/db";
import { PtyManager } from "../src/pty/manager";
import { startServer } from "../src/http/server";
import { Engine } from "../src/orchestrator/engine";
import { events as bus } from "../src/events";

describe("parseCli", () => {
  test("maps every subcommand", () => {
    expect(parseCli([])).toEqual({ cmd: "start", open: true });
    expect(parseCli(["start", "--no-open"])).toEqual({ cmd: "start", open: false });
    expect(parseCli(["--version"])).toEqual({ cmd: "version" });
    expect(parseCli(["doctor"])).toEqual({ cmd: "doctor" });
    expect(parseCli(["service", "enable"])).toEqual({ cmd: "service", action: "enable" });
    expect(parseCli(["restore", "rvmp-2026-07-23.sqlite"])).toEqual({ cmd: "restore", backup: "rvmp-2026-07-23.sqlite" });
    expect(parseCli(["restore"]).cmd).toBe("error");
    expect(parseCli(["service", "bogus"]).cmd).toBe("error");
    expect(parseCli(["task", "add", "Fix login", "--project", "/x"]))
      .toEqual({ cmd: "task-add", title: "Fix login", project: "/x" });
    expect(parseCli(["task", "add"]).cmd).toBe("error");
    expect(parseCli(["wat"]).cmd).toBe("error");
  });
});

test("restore verifies an rvmp snapshot, refuses a running daemon, and preserves the previous database", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rvmp-restore-"));
  const dbPath = join(dataDir, "db.sqlite");
  const live = openDb(dbPath);
  live.query(`INSERT INTO projects (id, name, path, base_branch, created_at) VALUES ('old', 'Old', '/old', 'main', 1)`).run();
  live.close();
  const backup = join(dataDir, "backups", "candidate.sqlite");
  const candidatePath = join(dataDir, "candidate.sqlite");
  const candidate = openDb(candidatePath);
  candidate.query(`INSERT INTO projects (id, name, path, base_branch, created_at) VALUES ('new', 'New', '/new', 'main', 1)`).run();
  candidate.close();
  copyFileSync(candidatePath, backup);

  expect((await restoreDatabase(backup, { dataDir, daemonProbe: async () => ({ running: true }) })).ok).toBe(false);
  const result = await restoreDatabase(backup, { dataDir, daemonProbe: async () => null });
  expect(result.ok).toBe(true);
  expect(existsSync(join(dataDir, "backups"))).toBe(true);
  const restored = openDb(dbPath);
  expect((restored.query(`SELECT name FROM projects`).all() as Array<{ name: string }>).map(row => row.name)).toEqual(["New"]);
  restored.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("doctor", () => {
  test("probes git + every registry agent via which; reports missing honestly", async () => {
    const rows = await doctorReport({
      which: (bin) => (bin === "git" || bin === "claude" ? `/usr/bin/${bin}` : null),
      service: { platform: "win32" }, // → unsupported, no host exec
    });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by["git"]).toMatchObject({ ok: true, detail: "/usr/bin/git" });
    expect(by["agent:claude"]).toMatchObject({ ok: true });
    expect(by["agent:codex"]).toMatchObject({ ok: false, detail: "missing" });
    expect(by["agent:generic"]).toBeUndefined(); // pseudo-agent never probed
    expect(by["service"]!.detail).toBe("unsupported");
    expect(by["port"]).toBeDefined();
    expect(by["data dir"]).toBeDefined();
  });
});

describe("task add against a live daemon", () => {
  const db = openDb(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "cg-cli-"));
  writeFileSync(join(dataDir, "token"), "clitoken");
  const ptys = new PtyManager(db, dataDir);
  const engine = new Engine({ db, ptys, adapters: { claude: null, codex: null }, events: bus, clock: Date.now });
  const port = 4790 + Math.floor(Math.random() * 100);
  const srv = startServer({ port, dataDir, token: "clitoken" }, db, ptys, engine);
  afterAll(() => {
    srv.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("finds the daemon by token probe, targets projects, queues the card", async () => {
    const probe = { dataDir, ports: [port] };
    // no projects yet → honest message
    expect((await taskAdd("T", null, probe)).message).toContain("no projects yet");

    const H = { "x-rvmp-token": "clitoken", "content-type": "application/json" };
    const dirA = mkdtempSync(join(tmpdir(), "cg-proj-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "cg-proj-b-"));
    await fetch(`http://127.0.0.1:${port}/api/projects`, { method: "POST", headers: H, body: JSON.stringify({ name: "A", path: dirA, skipGitCheck: true, baseBranch: "main" }) });
    const one = await taskAdd("First card", null, probe);
    expect(one).toMatchObject({ ok: true });
    expect(one.message).toContain("#");

    await fetch(`http://127.0.0.1:${port}/api/projects`, { method: "POST", headers: H, body: JSON.stringify({ name: "B", path: dirB, skipGitCheck: true, baseBranch: "main" }) });
    const ambiguous = await taskAdd("X", null, probe);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain("--project");
    const targeted = await taskAdd("Y", `${dirB}/`, probe); // trailing slash tolerated
    expect(targeted.ok).toBe(true);

    // wrong token file → daemon invisible
    const other = mkdtempSync(join(tmpdir(), "cg-cli2-"));
    writeFileSync(join(other, "token"), "wrong");
    expect(await findDaemon({ dataDir: other, ports: [port] })).toBeNull();
    rmSync(other, { recursive: true, force: true });
  });
});
