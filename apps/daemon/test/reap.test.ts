import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtySession } from "../src/pty/session";
import { currentPgid, listGroupPids, reapProcessGroup } from "../src/pty/reap";

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
