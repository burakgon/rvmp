import { test, expect, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtySession } from "../src/pty/session";
import {
  currentPgid,
  listGroupPids,
  reapProcessGroup,
} from "../src/pty/reap";
import { sweepSettingsDirs } from "../src/orchestrator/engine";

const dir = mkdtempSync(join(tmpdir(), "cg-reap-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const until = async (cond: () => Promise<boolean>, budgetMs = 3000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (await cond()) return true;
    await Bun.sleep(50);
  }
  return cond();
};

// The §6.1 post-exit reaping scenario, reproduced live: a PTY child (session +
// process-group leader, per docs/research/bun-pty-spike.md kill semantics)
// spawns HUP-immune grandchildren; the leader dies, the kernel HUP cascade
// misses them (inherited ignored disposition), and only a pgid-targeted
// SIGKILL clears the group.
test("reapProcessGroup SIGKILLs a HUP-immune leftover tree by pgid", async () => {
  const s = new PtySession({
    id: "reap-probe",
    cwd: "/tmp",
    cmd: ["/bin/sh", "-c", "trap '' HUP; sleep 30 & sleep 30 & echo READY; wait"],
    ringPath: join(dir, "reap.bin"),
  });
  // Wait for READY so both sleeps exist before we shoot the leader.
  await new Promise<void>((res) => {
    let buf = "";
    const off = s.onData((b) => {
      buf += new TextDecoder().decode(b);
      if (buf.includes("READY")) {
        off();
        res();
      }
    });
  });
  const pgid = s.pid; // PTY child is spawned as pgroup leader → pgid == pid
  expect(pgid).toBeGreaterThan(0);

  process.kill(pgid, "SIGKILL"); // leader dies; kernel HUPs the fg group; sleeps ignore HUP
  await s.exited;

  // The HUP-immune tree survived the leader's death…
  expect(await until(async () => (await listGroupPids(pgid)).length > 0, 1000)).toBe(true);
  const survivors = await listGroupPids(pgid);
  expect(survivors.length).toBeGreaterThan(0);
  expect(survivors).not.toContain(process.pid); // sanity: never our own process

  // …and only the reaper clears it.
  const killed = await reapProcessGroup(pgid);
  expect(killed.sort()).toEqual(survivors.sort());
  expect(await until(async () => (await listGroupPids(pgid)).length === 0)).toBe(true);
}, 15_000);

test("reapProcessGroup refuses nonsense pgids and its own group", async () => {
  expect(await reapProcessGroup(0)).toEqual([]);
  expect(await reapProcessGroup(-42)).toEqual([]);
  expect(await reapProcessGroup(1.5)).toEqual([]);
  const own = await currentPgid();
  expect(own).toBeGreaterThan(0);
  expect(await reapProcessGroup(own)).toEqual([]); // and we are demonstrably still alive
});

test("next-boot marker sweep reaps HUP-immune agent children after daemon SIGKILL", async () => {
  const dataDir = mkdtempSync(join(dir, "hard-kill-data-"));
  const settingsDir = join(dataDir, "agents", "hard-kill-dispatch");
  mkdirSync(settingsDir, { recursive: true });
  const helperPath = join(dir, `hard-kill-daemon-${crypto.randomUUID()}.ts`);
  const sessionModule = join(import.meta.dir, "../src/pty/session.ts");
  const reapModule = join(import.meta.dir, "../src/pty/reap.ts");
  await Bun.write(helperPath, `
    import { PtySession } from ${JSON.stringify(sessionModule)};
    import { recordProcessGroup } from ${JSON.stringify(reapModule)};
    const session = new PtySession({
      id: "hard-kill-agent",
      cwd: "/tmp",
      cmd: ["/bin/sh", "-c", "trap '' HUP; sleep 30 & sleep 30 & echo CHILDREN_READY; wait"],
      ringPath: ${JSON.stringify(join(dir, "hard-kill-agent.bin"))},
    });
    let output = "";
    session.onData((chunk) => {
      output += new TextDecoder().decode(chunk);
      if (!output.includes("CHILDREN_READY")) return;
      recordProcessGroup(${JSON.stringify(settingsDir)}, session.pid, "hard-kill-dispatch");
      console.log("MARKER_READY " + session.pid);
    });
    await new Promise(() => {});
  `);

  const helper = Bun.spawn({
    cmd: [process.execPath, helperPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  let pgid = 0;
  try {
    const reader = helper.stdout.getReader();
    const ready = (async () => {
      const decoder = new TextDecoder();
      let output = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error("helper exited before recording its process group");
          output += decoder.decode(value, { stream: true });
          const match = output.match(/MARKER_READY (\d+)/);
          if (match) return Number(match[1]);
        }
      } finally {
        reader.releaseLock();
      }
    })();
    pgid = await Promise.race([
      ready,
      Bun.sleep(5_000).then(() => { throw new Error("helper marker timeout"); }),
    ]);
    expect(pgid).toBeGreaterThan(1);

    // This helper stands in for the daemon. SIGKILL prevents every in-process
    // exited/finally callback, while its PTY group's ignored-HUP children live.
    helper.kill("SIGKILL");
    await helper.exited;
    expect(await until(async () => (await listGroupPids(pgid)).length > 0, 1_000)).toBe(true);
    const survivors = await listGroupPids(pgid);
    expect(survivors.length).toBeGreaterThan(0);

    // Simulated next boot through the production sweep: its rowless/terminal
    // settings dir carries the durable identity marker for the exact old group.
    const terminalDb = { query: () => ({ get: () => null }) } as unknown as Database;
    sweepSettingsDirs(terminalDb, dataDir);
    expect(await until(async () => (await listGroupPids(pgid)).length === 0)).toBe(true);
    expect(existsSync(settingsDir)).toBe(false);
  } finally {
    try { helper.kill("SIGKILL"); } catch {}
    if (pgid > 1) await reapProcessGroup(pgid);
  }
}, 15_000);
