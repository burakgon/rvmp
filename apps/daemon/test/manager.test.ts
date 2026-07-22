import { test, expect } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { openDb } from "../src/store/db";
import { PtyManager, sweepDeadRings } from "../src/pty/manager";
import { insertSession } from "../src/store/sessions";
import { createProject } from "../src/store/projects";
import { createCard, updateCard } from "../src/store/cards";
import { events } from "../src/events";

test("manager opens shell session, lists it, closes it, emits events", async () => {
  const db = openDb(":memory:");
  const seen: string[] = [];
  const off = events.on(e => { if (e.t === "session") seen.push(`${e.session.id}:${e.session.live}`); });
  const m = new PtyManager(db, `/tmp/rvmp-test-${crypto.randomUUID()}`);
  const meta = m.open({ projectId: "p1", cwd: "/tmp", title: "main" });
  expect(m.list("p1").length).toBe(1);
  expect(m.get(meta.id)).toBeDefined();
  expect(m.rename(meta.id, "renamed")?.title).toBe("renamed");
  expect(m.list("p1")[0]?.title).toBe("renamed");
  expect(m.close(meta.id)).toBe(true);
  await Bun.sleep(300);
  expect(seen[0]).toBe(`${meta.id}:true`);
  expect(seen.at(-1)).toBe(`${meta.id}:false`);
  off();
}, 15000);

test("manager persists kind and attemptId for agent sessions", async () => {
  const db = openDb(":memory:");
  const m = new PtyManager(db, `/tmp/rvmp-test-${crypto.randomUUID()}`);
  const meta = m.open({ projectId: "p1", cwd: "/tmp", title: "claude", kind: "agent", cmd: ["cat"], attemptId: 7 });
  expect(meta.kind).toBe("agent");
  expect(meta.attemptId).toBe(7);
  const listed = m.list("p1").find(s => s.id === meta.id)!;
  expect(listed.kind).toBe("agent"); // round-tripped through the sessions table
  expect(listed.attemptId).toBe(7);
  m.close(meta.id);
  await m.get(meta.id)?.exited;
}, 15000);

test("manager.open: insert failure kills the PTY and clears the live map (Plan-1 leak)", async () => {
  const db = openDb(":memory:");
  const m = new PtyManager(db, `/tmp/rvmp-test-${crypto.randomUUID()}`);
  // NOT NULL violation on sessions.project_id forces insertSession to throw
  // after the PTY was already spawned — exactly the stranded-PTY window.
  expect(() => m.open({ projectId: undefined as any, cwd: "/tmp", title: "boom" })).toThrow();
  expect(m.liveSessions().length).toBe(0); // not stranded in the map
}, 15000);

test("ring GC matrix: keeps latest agent ring per current attempt and live rings, deletes the rest", async () => {
  const db = openDb(":memory:");
  const dataDir = `/tmp/rvmp-gc-${crypto.randomUUID()}`;
  mkdirSync(`${dataDir}/rings`, { recursive: true });

  const project = createProject(db, { name: "gc", path: "/tmp", baseBranch: "main" });
  const card = createCard(db, { projectId: project.id, title: "t", body: "", agent: "claude" });
  updateCard(db, card.id, { attemptId: 10 }); // current attempt = 10

  const mkSession = (id: string, kind: "shell" | "agent", attemptId: number | null, live: boolean, createdAt: number) =>
    insertSession(db, {
      id, projectId: project.id, kind, title: id, cwd: "/tmp",
      worktreeId: null, live, createdAt, adapterSessionId: null, attemptId,
    });

  mkSession("agent-old", "agent", 10, false, 1000); // superseded agent session of the current attempt
  mkSession("agent-new", "agent", 10, false, 2000); // latest agent session of the current attempt → KEEP
  mkSession("agent-stale", "agent", 15, false, 3000); // attempt 15 is no card's current attempt
  mkSession("shell-dead", "shell", null, false, 1000); // dead shell rings always die
  mkSession("shell-live", "shell", null, true, 1000); // live rows are never swept

  for (const id of ["agent-old", "agent-new", "agent-stale", "shell-dead", "shell-live", "orphan"])
    await Bun.write(`${dataDir}/rings/${id}.bin`, id);

  sweepDeadRings(db, dataDir);

  expect(existsSync(`${dataDir}/rings/agent-new.bin`)).toBe(true);
  expect(existsSync(`${dataDir}/rings/shell-live.bin`)).toBe(true);
  expect(existsSync(`${dataDir}/rings/agent-old.bin`)).toBe(false);
  expect(existsSync(`${dataDir}/rings/agent-stale.bin`)).toBe(false);
  expect(existsSync(`${dataDir}/rings/shell-dead.bin`)).toBe(false);
  expect(existsSync(`${dataDir}/rings/orphan.bin`)).toBe(false); // no session row at all
});
