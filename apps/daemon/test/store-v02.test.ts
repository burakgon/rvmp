import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, MIGRATIONS } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { createCard, updateCard, listCards } from "../src/store/cards";
import { insertSession, listSessions } from "../src/store/sessions";
import {
  createAttempt, createDispatch, completeDispatch,
  touchDispatchProgress, failRunningDispatches,
} from "../src/store/attempts";

const V1_MIGRATION_COUNT = 4; // MIGRATIONS[0..3] are the frozen v0.1 schema

const tmp = mkdtempSync(join(tmpdir(), "codegent-store-v02-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Build a database exactly as a v0.1 daemon left it: schema migrations 0..3
 * applied and recorded, plus rows using the retired phases. */
function seedV01Db(path: string): void {
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode=WAL;");
  raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY);`);
  MIGRATIONS.slice(0, V1_MIGRATION_COUNT).forEach((sql, idx) => {
    raw.exec(sql);
    raw.query(`INSERT INTO _migrations (idx) VALUES (?1)`).run(idx);
  });
  const now = Date.now();
  raw.query(`INSERT INTO projects (id, name, path, base_branch, created_at) VALUES ('p1', 'P', '/tmp/p', 'main', ?1)`).run(now);
  const ins = raw.query(
    `INSERT INTO cards (project_id, title, body, phase, agent, position, created_at, updated_at)
     VALUES ('p1', ?1, '', ?2, 'claude', ?3, ?4, ?4)`
  );
  ins.run("was-waiting", "waiting", 1, now);
  ins.run("was-running", "running", 2, now);
  ins.run("was-queued", "queued", 3, now);
  raw.close();
}

test("v0.1 waiting/running cards migrate to spec-true v0.2 shape", () => {
  const path = join(tmp, "migrate.db");
  const before = Date.now();
  seedV01Db(path);
  const db = openDb(path); // applies migration 2
  const byTitle = Object.fromEntries(listCards(db, "p1").map(c => [c.title, c]));

  const waiting = byTitle["was-waiting"]!;
  expect(waiting.phase).toBe("working");
  expect(waiting.inputKind).toBe("silent");
  expect(waiting.inputSince).toBeGreaterThanOrEqual(before - 2000); // strftime has second precision
  expect(waiting.inputSince).toBeLessThanOrEqual(Date.now() + 2000);
  expect(waiting.workingSub).toBeNull();

  const running = byTitle["was-running"]!;
  expect(running.phase).toBe("working");
  expect(running.workingSub).toBe("running");
  expect(running.inputKind).toBeNull();
  expect(running.inputSince).toBeNull();

  const queued = byTitle["was-queued"]!;
  expect(queued.phase).toBe("queued");
  expect(queued.workingSub).toBeNull();
  expect(queued.errorKind).toBeNull();
  expect(queued.reviewSub).toBeNull();
  expect(queued.round).toBe(1);
  expect(queued.auto).toBe(true);
  expect(queued.attemptId).toBeNull();
  db.close();
});

test("migrating twice is a no-op", () => {
  const path = join(tmp, "idempotent.db");
  seedV01Db(path);
  const first = openDb(path);
  const applied = first.query(`SELECT COUNT(*) AS n FROM _migrations`).get() as any;
  const snapshot = listCards(first, "p1");
  first.close();

  const second = openDb(path); // must not throw or re-run the data fix-up
  const appliedAgain = second.query(`SELECT COUNT(*) AS n FROM _migrations`).get() as any;
  expect(appliedAgain.n).toBe(applied.n);
  expect(listCards(second, "p1")).toEqual(snapshot);
  second.close();
});

// Fresh in-memory db (full v0.2 schema) for the store-function tests.
const db = openDb(":memory:");
const proj = createProject(db, { name: "V2", path: "/tmp/v2", baseBranch: "main" });
const cardA = createCard(db, { projectId: proj.id, title: "A", body: "", agent: "claude" });
const cardB = createCard(db, { projectId: proj.id, title: "B", body: "", agent: "claude" });

test("attempt seq increments per card", () => {
  const a1 = createAttempt(db, { cardId: cardA.id, worktreeId: "wt-1", beforeHead: "abc123" });
  const a2 = createAttempt(db, { cardId: cardA.id, worktreeId: "wt-1", beforeHead: "def456" });
  const b1 = createAttempt(db, { cardId: cardB.id, worktreeId: null, beforeHead: null });
  expect(a1.seq).toBe(1);
  expect(a2.seq).toBe(2);
  expect(b1.seq).toBe(1); // per-card, not global
  expect(a1.status).toBe("running");
  expect(a1.cardId).toBe(cardA.id);
  expect(a1.worktreeId).toBe("wt-1");
  expect(a1.beforeHead).toBe("abc123");
});

test("completeDispatch is write-once", () => {
  const attempt = createAttempt(db, { cardId: cardA.id, worktreeId: null, beforeHead: null });
  const d = createDispatch(db, attempt.id);
  expect(d.status).toBe("running");
  expect(d.attemptId).toBe(attempt.id);
  expect(completeDispatch(db, d.id, "done")?.status).toBe("done");
  expect(completeDispatch(db, d.id, "failed")).toBeNull(); // stale retry can't overwrite
  // simulated two-caller race: both raced UPDATEs already ran above; row keeps the winner
  const row = db.query(`SELECT status FROM dispatches WHERE id = ?1`).get(d.id) as any;
  expect(row.status).toBe("done");
});

test("touchDispatchProgress updates running dispatches only", () => {
  const attempt = createAttempt(db, { cardId: cardA.id, worktreeId: null, beforeHead: null });
  const d = createDispatch(db, attempt.id);
  expect(d.lastProgressAt).toBeNull();
  touchDispatchProgress(db, d.id, 12345);
  let row = db.query(`SELECT last_progress_at FROM dispatches WHERE id = ?1`).get(d.id) as any;
  expect(row.last_progress_at).toBe(12345);
  completeDispatch(db, d.id, "interrupted");
  touchDispatchProgress(db, d.id, 99999); // stale progress after terminal → ignored
  row = db.query(`SELECT last_progress_at FROM dispatches WHERE id = ?1`).get(d.id) as any;
  expect(row.last_progress_at).toBe(12345);
});

test("failRunningDispatches flips only running rows", () => {
  const boot = openDb(":memory:");
  const p = createProject(boot, { name: "Boot", path: "/tmp/boot", baseBranch: "main" });
  const c = createCard(boot, { projectId: p.id, title: "C", body: "", agent: "claude" });
  const at = createAttempt(boot, { cardId: c.id, worktreeId: null, beforeHead: null });
  const done = createDispatch(boot, at.id);
  completeDispatch(boot, done.id, "done");
  const r1 = createDispatch(boot, at.id);
  const r2 = createDispatch(boot, at.id);

  expect(failRunningDispatches(boot)).toBe(2);
  const statuses = boot.query(`SELECT id, status FROM dispatches`).all() as any[];
  const byId = Object.fromEntries(statuses.map(r => [r.id, r.status]));
  expect(byId[done.id]).toBe("done"); // terminal rows untouched
  expect(byId[r1.id]).toBe("failed");
  expect(byId[r2.id]).toBe("failed");
  expect(failRunningDispatches(boot)).toBe(0); // second boot pass: nothing left
  boot.close();
});

test("updateCard round-trips the v0.2 fields", () => {
  const at = createAttempt(db, { cardId: cardB.id, worktreeId: null, beforeHead: null });
  const patched = updateCard(db, cardB.id, {
    phase: "working", workingSub: "starting", errorKind: null, reviewSub: null,
    inputKind: "permission", inputSince: 777, round: 3, auto: false, attemptId: at.id,
  });
  expect(patched.workingSub).toBe("starting");
  expect(patched.inputKind).toBe("permission");
  expect(patched.inputSince).toBe(777);
  expect(patched.round).toBe(3);
  expect(patched.auto).toBe(false);
  expect(patched.attemptId).toBe(at.id);

  const reread = listCards(db, proj.id).find(c => c.id === cardB.id)!;
  expect(reread).toEqual(patched);

  const reviewed = updateCard(db, cardB.id, {
    phase: "review", workingSub: null, reviewSub: "ready", errorKind: null,
    inputKind: null, inputSince: null, auto: true,
  });
  expect(reviewed.phase).toBe("review");
  expect(reviewed.workingSub).toBeNull();
  expect(reviewed.reviewSub).toBe("ready");
  expect(reviewed.inputSince).toBeNull();
  expect(reviewed.auto).toBe(true);
  expect(reviewed.round).toBe(3); // untouched fields survive
});

test("sessions round-trip kind/adapterSessionId/attemptId", () => {
  const at = createAttempt(db, { cardId: cardA.id, worktreeId: null, beforeHead: null });
  insertSession(db, {
    id: "s-agent", projectId: proj.id, kind: "agent", title: "agent run",
    cwd: "/tmp/v2", worktreeId: null, live: true, createdAt: Date.now(),
    adapterSessionId: "claude-abc", attemptId: at.id,
  });
  insertSession(db, {
    id: "s-shell", projectId: proj.id, kind: "shell", title: "shell",
    cwd: "/tmp/v2", worktreeId: null, live: true, createdAt: Date.now() + 1,
  });
  const [agent, shell] = listSessions(db, proj.id);
  expect(agent!.kind).toBe("agent");
  expect(agent!.adapterSessionId).toBe("claude-abc");
  expect(agent!.attemptId).toBe(at.id);
  expect(shell!.kind).toBe("shell");
  expect(shell!.adapterSessionId).toBeNull();
  expect(shell!.attemptId).toBeNull();
});
