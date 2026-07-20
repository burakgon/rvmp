import { test, expect, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, DomainEvent, Project, SessionMeta, Worktree } from "@codegent/protocol";
import { openDb } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { createCard, getCard, updateCard } from "../src/store/cards";
import { completeDispatch, createAttempt, createDispatch, getAttempt } from "../src/store/attempts";
import { appendTimeline, listTimeline } from "../src/store/timeline";
import { insertSession, setSessionLive } from "../src/store/sessions";
import type { OpenSessionOpts } from "../src/pty/manager";
import type { AgentAdapter, AdapterSignal, SpawnCtx, SpawnResult } from "../src/agents/types";
import { ClaudeAdapter } from "../src/agents/claude";
import { handleAgentApi } from "../src/agents/mcp";
import {
  Engine, CardNotFound, NothingToUndo, RESTART_NOTE,
  bootReconcile, buildResumeContext, sweepSettingsDirs,
} from "../src/orchestrator/engine";
import { IllegalTransition } from "../src/orchestrator/machine";
import { startServer } from "../src/http/server";

// ---------------------------------------------------------------------------
// Harness — engine.test.ts's world, extended for recovery: FakeSess can `die`
// with an exit CODE (crash detection input), FakePtys satisfies BOTH the
// engine's and the adapter's structural slices (so one world can run the REAL
// ClaudeAdapter for argv assertions), and worlds can run on a FILE-backed db
// that is closed and reopened to simulate a daemon crash + reboot.
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cg-rec-"));
  cleanups.push(d);
  return d;
};

const sh = async (cwd: string, ...cmd: string[]): Promise<string> => {
  const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited, new Response(p.stdout).text(), new Response(p.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
};

async function makeRepo(): Promise<string> {
  const repo = mkTmp();
  await sh(repo, "git", "init", "-b", "main");
  await sh(repo, "git", "config", "user.email", "t@t");
  await sh(repo, "git", "config", "user.name", "t");
  await Bun.write(join(repo, "a.txt"), "hello\n");
  await sh(repo, "git", "add", "-A");
  await sh(repo, "git", "commit", "-m", "init");
  return repo;
}

class FakeSess {
  writes: string[] = [];
  killed = false;
  pid = 0; // 0 → engine skips real process-group reaping for fakes
  private dataCbs = new Set<(b: Uint8Array) => void>();
  private resolveExit!: (n: number) => void;
  readonly exited = new Promise<number>((res) => (this.resolveExit = res));
  constructor(private onDead: () => void) {
    // First paint ≈ CLI banner: lets the real adapter's paste-readiness gate
    // resolve on its quiet window instead of waiting out the cap.
    setTimeout(() => {
      for (const cb of this.dataCbs) cb(new TextEncoder().encode("banner"));
    }, 2);
  }
  write(d: Uint8Array | string): void {
    this.writes.push(typeof d === "string" ? d : new TextDecoder().decode(d));
  }
  onData(cb: (b: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }
  terminate(): Promise<number> {
    this.die(0);
    return this.exited;
  }
  /** The process ended on its own with `code` (crash, clean exit, …). */
  die(code: number): void {
    if (this.killed) return;
    this.killed = true;
    this.onDead();
    this.resolveExit(code);
  }
}

class FakePtys {
  all = new Map<string, FakeSess>();
  opened: OpenSessionOpts[] = [];
  constructor(private db: Database) {}
  open(opts: OpenSessionOpts): SessionMeta {
    this.opened.push(opts);
    const id = `fp-${this.opened.length}-${crypto.randomUUID().slice(0, 4)}`;
    const meta: SessionMeta = {
      id, projectId: opts.projectId, kind: opts.kind ?? "shell", title: opts.title,
      cwd: opts.cwd, worktreeId: opts.worktreeId ?? null, live: true, createdAt: Date.now(),
      adapterSessionId: null, attemptId: opts.attemptId ?? null,
    };
    insertSession(this.db, meta);
    this.all.set(id, new FakeSess(() => setSessionLive(this.db, id, false)));
    return meta;
  }
  get(id: string): FakeSess | undefined {
    const s = this.all.get(id);
    return s && !s.killed ? s : undefined;
  }
  die(id: string, code: number): void {
    this.all.get(id)?.die(code);
  }
}

class FakeAdapter implements AgentAdapter {
  readonly agent = "claude" as const;
  behavior: "ok" | "reject" = "ok";
  spawns: SpawnCtx[] = [];
  constructor(private ptys: FakePtys) {}
  async spawn(ctx: SpawnCtx): Promise<SpawnResult> {
    this.spawns.push(ctx);
    if (this.behavior === "reject") throw new Error("spawn failed (scripted)");
    const meta = this.ptys.open({
      projectId: ctx.project.id, cwd: ctx.worktreePath, title: ctx.card.title,
      worktreeId: ctx.attempt.worktreeId, kind: "agent", attemptId: ctx.attempt.id,
    });
    return {
      sessionMeta: meta,
      settingsDir: "/tmp/fake-settings",
      exited: this.ptys.all.get(meta.id)!.exited,
    };
  }
  onHook(_sessionId: string, _event: unknown): AdapterSignal[] {
    return [];
  }
}

interface World {
  db: Database;
  repo: string;
  project: Project;
  ptys: FakePtys;
  adapter: FakeAdapter;
  events: DomainEvent[];
  engine: Engine;
}

function buildEngine(db: Database, ptys: FakePtys, adapter: AgentAdapter, events: DomainEvent[]): Engine {
  return new Engine({
    db, ptys,
    adapters: { claude: adapter, codex: null },
    events: { emit: (e) => events.push(e) },
    clock: Date.now,
    timers: { spawnTimeoutMs: 5_000, injectSettleMs: 1 },
  });
}

async function makeWorld(opts: { dbPath?: string } = {}): Promise<World> {
  const db = openDb(opts.dbPath ?? ":memory:");
  const repo = await makeRepo();
  const project = createProject(db, { name: "R", path: repo, baseBranch: "main" });
  const ptys = new FakePtys(db);
  const adapter = new FakeAdapter(ptys);
  const events: DomainEvent[] = [];
  return { db, repo, project, ptys, adapter, events, engine: buildEngine(db, ptys, adapter, events) };
}

/** Same world, but wired to the REAL ClaudeAdapter — for argv assertions. */
async function makeRealWorld(): Promise<Omit<World, "adapter"> & { dataDir: string }> {
  const db = openDb(":memory:");
  const repo = await makeRepo();
  const project = createProject(db, { name: "RR", path: repo, baseBranch: "main" });
  const ptys = new FakePtys(db);
  const dataDir = mkTmp();
  const adapter = new ClaudeAdapter({
    dataDir, hookPort: 45999, hookToken: "tok", ptys,
    timing: { capMs: 80, minReadyMs: 0, quietMs: 10, enterDelayMs: 2 },
  });
  const events: DomainEvent[] = [];
  return { db, repo, project, ptys, events, dataDir, engine: buildEngine(db, ptys, adapter, events) };
}

const card = (w: { db: Database; project: Project }, title: string, over: Partial<Pick<Card, "agent" | "auto">> = {}): Card => {
  let c = createCard(w.db, { projectId: w.project.id, title, body: "do it", agent: over.agent ?? "claude" });
  if (over.auto === false) c = updateCard(w.db, c.id, { auto: false });
  return c;
};

const dispatchOf = (db: Database, cardId: number): { id: string; status: string; attempt_id: number } =>
  db.query(
    `SELECT d.id AS id, d.status AS status, d.attempt_id AS attempt_id
     FROM dispatches d JOIN attempts a ON a.id = d.attempt_id
     WHERE a.card_id = ?1 ORDER BY d.rowid DESC LIMIT 1`,
  ).get(cardId) as any;

const dispatchStatus = (db: Database, id: string): string | null =>
  (db.query(`SELECT status FROM dispatches WHERE id = ?1`).get(id) as any)?.status ?? null;

const attemptRows = (db: Database, cardId: number): Array<{ seq: number; status: string; worktree_id: string | null }> =>
  db.query(`SELECT seq, status, worktree_id FROM attempts WHERE card_id = ?1 ORDER BY seq`).all(cardId) as any;

const wtRows = (db: Database): Array<Worktree> =>
  db.query(`SELECT * FROM worktrees`).all().map((r: any) => ({
    id: r.id, projectId: r.project_id, branch: r.branch, path: r.path, base: r.base, state: r.state,
  })) as any;

async function toRunning(w: { db: Database; engine: Engine }, c: Card, asid = `asid-${c.id}`): Promise<string> {
  await w.engine.start(c.id);
  const d = dispatchOf(w.db, c.id);
  w.engine.handleSignal(d.id, { s: "session-started", adapterSessionId: asid });
  expect(getCard(w.db, c.id)!.workingSub).toBe("running");
  return d.id;
}

const agentSessionId = (w: { db: Database }, cardId: number): string => {
  const c = getCard(w.db, cardId)!;
  const row = w.db.query(
    `SELECT id FROM sessions WHERE attempt_id = ?1 AND kind = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(c.attemptId) as any;
  return row.id;
};

/** Let session-exit promise chains run, then wait out engine background work. */
async function settle(w: { engine: Engine }): Promise<void> {
  await Bun.sleep(1);
  await w.engine.idle();
  await Bun.sleep(1);
  await w.engine.idle();
}

// ---------------------------------------------------------------------------
// Crash detection: exit code × Stop-seen truth table
// ---------------------------------------------------------------------------

test("exit≠0 with no Stop-class signal → error(crashed), attempt+dispatch failed, slot refilled", async () => {
  const w = await makeWorld();
  const a = card(w, "will crash");
  const b = card(w, "next in line");
  await toRunning(w, a);
  expect(getCard(w.db, b.id)!.phase).toBe("queued"); // slot held by a

  w.ptys.die(agentSessionId(w, a.id), 137);
  await settle(w);

  const cur = getCard(w.db, a.id)!;
  expect(cur.workingSub).toBe("error");
  expect(cur.errorKind).toBe("crashed");
  expect(dispatchOf(w.db, a.id).status).toBe("failed");
  expect(attemptRows(w.db, a.id)[0]!.status).toBe("failed");
  // R1: the crash freed the slot — b started with no explicit tick.
  expect(getCard(w.db, b.id)!.phase).toBe("working");
});

test("clean exit 0 without task_complete is NOT a crash — card stays working (v0.3 silent lane)", async () => {
  const w = await makeWorld();
  const c = card(w, "quiet exit");
  const d = await toRunning(w, c);

  w.ptys.die(agentSessionId(w, c.id), 0);
  await settle(w);

  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("working");
  expect(cur.workingSub).toBe("running");
  expect(cur.errorKind).toBeNull();
  expect(dispatchStatus(w.db, d)).toBe("running");
});

test("exit≠0 AFTER a Stop-class signal is NOT a crash (the question mapping already handled it)", async () => {
  const w = await makeWorld();
  const c = card(w, "stopped then died");
  const d = await toRunning(w, c);

  w.engine.handleSignal(d, { s: "complete-eval" }); // Stop without marker → question flag
  expect(getCard(w.db, c.id)!.inputKind).toBe("question");
  w.ptys.die(agentSessionId(w, c.id), 1);
  await settle(w);

  const cur = getCard(w.db, c.id)!;
  expect(cur.workingSub).toBe("running"); // still working — no crash rewrite
  expect(cur.inputKind).toBe("question");
  expect(dispatchStatus(w.db, d)).toBe("running");
});

test("crash during working.starting (no SessionStart yet) → error(crashed)", async () => {
  const w = await makeWorld();
  const c = card(w, "died at spawn");
  await w.engine.start(c.id);
  expect(getCard(w.db, c.id)!.workingSub).toBe("starting");

  w.ptys.die(agentSessionId(w, c.id), 127);
  await settle(w);

  const cur = getCard(w.db, c.id)!;
  expect(cur.workingSub).toBe("error");
  expect(cur.errorKind).toBe("crashed");
});

// ---------------------------------------------------------------------------
// Boot reconciliation v2 — flips exactly the right rows, idempotent
// ---------------------------------------------------------------------------

test("bootReconcile flips working→error(interrupted) + running rows→failed; queued/done untouched; idempotent", async () => {
  const dbPath = join(mkTmp(), "db.sqlite");
  const w = await makeWorld({ dbPath });
  const working = card(w, "was working");
  const queued = card(w, "still queued", { auto: false });
  const done = card(w, "already done", { auto: false });
  updateCard(w.db, done.id, { phase: "done" });
  const d = await toRunning(w, working);
  w.db.close(); // daemon crash

  const db2 = openDb(dbPath);
  const events: DomainEvent[] = [];
  const flipped = bootReconcile(db2, { emit: (e) => events.push(e) }, Date.now());

  expect(flipped).toEqual([working.id]);
  const cur = getCard(db2, working.id)!;
  expect(cur.phase).toBe("working");
  expect(cur.workingSub).toBe("error");
  expect(cur.errorKind).toBe("interrupted");
  expect(dispatchStatus(db2, d)).toBe("failed");
  expect(attemptRows(db2, working.id)[0]!.status).toBe("failed");
  // Exactly one card event, for the flipped card only.
  expect(events.map((e) => e.t)).toEqual(["card"]);
  expect((events[0] as any).card.id).toBe(working.id);
  // Untouched rows.
  expect(getCard(db2, queued.id)!.phase).toBe("queued");
  expect(getCard(db2, queued.id)!.errorKind).toBeNull();
  expect(getCard(db2, done.id)!.phase).toBe("done");

  // Idempotent: a second boot flips nothing and emits nothing.
  const again = bootReconcile(db2, { emit: (e) => events.push(e) }, Date.now());
  expect(again).toEqual([]);
  expect(events.length).toBe(1);
  db2.close();
});

// ---------------------------------------------------------------------------
// Boot order — the aliased round-2 wedge closure (review obligation 1)
// ---------------------------------------------------------------------------

test("reboot closes the aliased wedge: dispatch failed, card interrupted, late task_complete drops cleanly, resume continues the conversation", async () => {
  const dbPath = join(mkTmp(), "db.sqlite");
  const w = await makeWorld({ dbPath });
  const c = card(w, "round tripper");
  const d1 = await toRunning(w, c); // captures asid-<id> into the sessions table
  w.engine.completeFromApi(d1);
  await w.engine.idle();
  await w.engine.sendBack(c.id, ["more polish"]); // LIVE session → alias d1→d2
  const d2 = dispatchOf(w.db, c.id).id;
  expect(d2).not.toBe(d1);
  w.db.close(); // daemon crash with round 2 mid-flight; the CC process survives

  // Reboot: fresh db handle, fresh engine (the alias map is gone).
  const db2 = openDb(dbPath);
  const events2: DomainEvent[] = [];
  bootReconcile(db2, { emit: (e) => events2.push(e) }, Date.now());
  expect(dispatchStatus(db2, d2)).toBe("failed");
  const cur = getCard(db2, c.id)!;
  expect(cur.workingSub).toBe("error");
  expect(cur.errorKind).toBe("interrupted");

  const ptys2 = new FakePtys(db2);
  const adapter2 = new FakeAdapter(ptys2);
  const engine2 = buildEngine(db2, ptys2, adapter2, events2);
  const tlBefore = listTimeline(db2, c.id).length;

  // The surviving session's late task_complete, addressed by its SPAWN-TIME key
  // (d1, terminal `done`) and by the boot-failed round-2 dispatch (d2): both
  // drop at the write-once latch — no timeline row, no transition, no wedge.
  const complete = (dispatch: string) =>
    handleAgentApi(
      new Request("http://x/api/agent/complete", { method: "POST" }),
      new URL("http://x/api/agent/complete"),
      { card: c.id, dispatch, summary: "late!" },
      db2, engine2,
    );
  const r1 = await complete(d1);
  expect(r1.status).toBe(200);
  expect(((await r1.json()) as any).stale).toBe(true);
  const r2 = await complete(d2);
  expect(((await r2.json()) as any).stale).toBe(true);
  const r3 = await complete("no-such-dispatch");
  expect(r3.status).toBe(404);
  expect(listTimeline(db2, c.id).length).toBe(tlBefore);
  expect(getCard(db2, c.id)!.errorKind).toBe("interrupted"); // still the honest state
  expect((db2.query(`SELECT pending_complete AS p FROM dispatches WHERE id = ?1`).get(d1) as any).p).toBe(0);
  expect((db2.query(`SELECT pending_complete AS p FROM dispatches WHERE id = ?1`).get(d2) as any).p).toBe(0);

  // One-click resume: same conversation via the PERSISTED adapter session id
  // (the in-memory capture died with the old daemon), same attempt+worktree.
  await engine2.resume(c.id);
  const ctx = adapter2.spawns[0]!;
  expect(ctx.resumeSessionId).toBe(`asid-${c.id}`);
  expect(ctx.attempt.id).toBe(cur.attemptId!);
  expect(getAttempt(db2, cur.attemptId!)!.status).toBe("running"); // attempt revived
  const d3 = dispatchOf(db2, c.id);
  expect(d3.id).not.toBe(d2);
  expect(d3.status).toBe("running");
  expect(getCard(db2, c.id)!.workingSub).toBe("starting");
  engine2.handleSignal(d3.id, { s: "session-started", adapterSessionId: `asid-${c.id}` });
  expect(getCard(db2, c.id)!.workingSub).toBe("running");
  db2.close();
});

// ---------------------------------------------------------------------------
// Resume — mode re-pass (real argv) + context-block fallback
// ---------------------------------------------------------------------------

test("resume re-passes the persisted execution mode as real argv (--dangerously-skip-permissions + --resume)", async () => {
  const w = await makeRealWorld();
  const c = card(w, "host mode job");
  await w.engine.start(c.id);
  const d = dispatchOf(w.db, c.id);
  const attemptId = getCard(w.db, c.id)!.attemptId!;
  // Spawn persisted the mode on the attempt row (v0.2 fresh starts are auto).
  expect(getAttempt(w.db, attemptId)!.mode).toBe("auto");
  // Stand-in for an original host-mode run: what matters is that resume reads
  // the ROW, not a compiled-in default.
  w.db.query(`UPDATE attempts SET mode = 'host' WHERE id = ?1`).run(attemptId);
  w.engine.handleSignal(d.id, { s: "session-started", adapterSessionId: "asid-real" });
  w.ptys.die(agentSessionId(w, c.id), 1);
  await settle(w);
  expect(getCard(w.db, c.id)!.errorKind).toBe("crashed");

  await w.engine.resume(c.id);
  const cmd = w.ptys.opened.at(-1)!.cmd!;
  expect(cmd[0]).toBe("claude");
  expect(cmd).toContain("--dangerously-skip-permissions"); // original mode flags re-passed
  expect(cmd).not.toContain("--permission-mode");
  expect(cmd.slice(-2)).toEqual(["--resume", "asid-real"]); // same conversation
});

test("resume without an adapter session id seeds a fresh dispatch with the context block (task + last progress + porcelain)", async () => {
  const w = await makeWorld();
  const c = card(w, "context fallback");
  await w.engine.start(c.id); // NO session-started → no adapter session id anywhere
  appendTimeline(w.db, c.id, "progress", "wired the frobnicator");
  appendTimeline(w.db, c.id, "progress", "half-done: needs tests");
  const wt = wtRows(w.db)[0]!;
  writeFileSync(join(wt.path, "partial.ts"), "wip\n");
  w.ptys.die(agentSessionId(w, c.id), 1);
  await settle(w);
  expect(getCard(w.db, c.id)!.errorKind).toBe("crashed");

  await w.engine.resume(c.id);
  const ctx = w.adapter.spawns.at(-1)!;
  expect(ctx.resumeSessionId ?? null).toBeNull();
  expect(ctx.mode).toBe("auto"); // persisted mode still re-passed
  const block = ctx.extraPrompt!;
  expect(block).toContain("context fallback"); // task_get content: title…
  expect(block).toContain("do it"); // …and body
  expect(block).toContain("half-done: needs tests"); // LAST progress note
  expect(block).toContain("partial.ts"); // git status --porcelain summary
  // Same worktree, same attempt, new dispatch; card back on the working path.
  expect(ctx.worktreePath).toBe(wt.path);
  expect(ctx.attempt.id).toBe(getCard(w.db, c.id)!.attemptId!);
  expect(attemptRows(w.db, c.id).length).toBe(1);
  expect(getCard(w.db, c.id)!.workingSub).toBe("starting");
});

test("buildResumeContext is pure and never renders absent parts", () => {
  const full = buildResumeContext({ title: "T", body: "B", lastProgress: "p9", porcelain: "M a.ts" });
  expect(full).toContain("T");
  expect(full).toContain("B");
  expect(full).toContain("p9");
  expect(full).toContain("M a.ts");
  const bare = buildResumeContext({ title: "T", body: "", lastProgress: null, porcelain: null });
  expect(bare).toContain("T");
  expect(bare).not.toContain("null");
  expect(bare).not.toContain("undefined");
  // pure: same input → same output
  expect(buildResumeContext({ title: "T", body: "", lastProgress: null, porcelain: null })).toBe(bare);
});

test("buildResumeContext caps a monster porcelain: 50 lines / ~4KB head, then an '…and N more' summary", () => {
  // Line cap: 120 one-line entries → first 50 kept, 70 summarized.
  const many = Array.from({ length: 120 }, (_, i) => `?? file-${i}.ts`).join("\n");
  const capped = buildResumeContext({ title: "T", body: "", lastProgress: null, porcelain: many });
  expect(capped).toContain("?? file-0.ts");
  expect(capped).toContain("?? file-49.ts");
  expect(capped).not.toContain("?? file-50.ts");
  expect(capped).toContain("…and 70 more");

  // Byte cap binds before the line cap on huge paths: 10 × ~900B lines → only
  // the ~4KB head survives, at least one line always kept.
  const huge = Array.from({ length: 10 }, (_, i) => `?? ${"x".repeat(900)}-${i}`).join("\n");
  const capped2 = buildResumeContext({ title: "T", body: "", lastProgress: null, porcelain: huge });
  const omitted = Number(capped2.match(/…and (\d+) more/)![1]);
  expect(omitted).toBeGreaterThan(0);
  expect(omitted).toBeLessThan(10);

  // Under both caps: rendered verbatim, no summary line.
  const small = buildResumeContext({ title: "T", body: "", lastProgress: null, porcelain: "M a.ts" });
  expect(small).toContain("M a.ts");
  expect(small).not.toMatch(/…and \d+ more/);
});

// ---------------------------------------------------------------------------
// Restart — fresh conversation, same worktree, fixed note, NEVER git reset
// ---------------------------------------------------------------------------

test("restart spawns a fresh conversation on the same worktree with the fixed note — and never runs git reset", async () => {
  const w = await makeWorld();
  const c = card(w, "restartable");
  await toRunning(w, c);
  const wtId = getCard(w.db, c.id)!.worktreeId!;
  const wt = wtRows(w.db)[0]!;
  writeFileSync(join(wt.path, "partial-work.txt"), "half\n"); // uncommitted partial work
  w.ptys.die(agentSessionId(w, c.id), 1);
  await settle(w);
  expect(getCard(w.db, c.id)!.errorKind).toBe("crashed");

  // Git-call spy: record every `git …` argv spawned during restart.
  const gitCalls: string[][] = [];
  const orig = Bun.spawn;
  (Bun as any).spawn = (opts: any, more?: any) => {
    const cmd = Array.isArray(opts) ? opts : opts?.cmd;
    if (Array.isArray(cmd) && cmd[0] === "git") gitCalls.push(cmd.map(String));
    return (orig as any).call(Bun, opts, more);
  };
  try {
    await w.engine.restart(c.id);
  } finally {
    (Bun as any).spawn = orig;
  }

  expect(gitCalls.length).toBeGreaterThan(0); // the spy saw the pipeline
  expect(gitCalls.some((cmd) => cmd.includes("reset"))).toBe(false); // §9.1: NEVER git reset
  expect(existsSync(join(wt.path, "partial-work.txt"))).toBe(true); // partial work intact

  const cur = getCard(w.db, c.id)!;
  expect(cur.workingSub).toBe("starting");
  expect(cur.worktreeId).toBe(wtId); // same worktree, no new tree
  expect(wtRows(w.db).length).toBe(1);
  const ctx = w.adapter.spawns.at(-1)!;
  expect(ctx.resumeSessionId ?? null).toBeNull(); // fresh conversation
  expect(ctx.extraPrompt).toBe(RESTART_NOTE);
  expect(RESTART_NOTE).toBe("previous attempt stopped midway; worktree may contain partial work");
  const attempts = attemptRows(w.db, c.id);
  expect(attempts.map((a) => a.status)).toEqual(["failed", "running"]); // NEW attempt
  expect(getAttempt(w.db, ctx.attempt.id)!.mode).toBe("auto"); // mode carried onto it
});

test("fresh restart never backfills an old conversation id and ignores late SessionStart from the old dispatch", async () => {
  const w = await makeWorld();
  const c = card(w, "fresh identity");
  const oldDispatch = await toRunning(w, c, "asid-old-conversation");
  w.ptys.die(agentSessionId(w, c.id), 1);
  await settle(w);

  await w.engine.restart(c.id);
  const restarted = getCard(w.db, c.id)!;
  const newDispatch = dispatchOf(w.db, c.id);
  const newSessionId = agentSessionId(w, c.id);
  expect(newDispatch.id).not.toBe(oldDispatch);
  expect((w.db.query(
    `SELECT adapter_session_id AS id FROM sessions WHERE id = ?1`,
  ).get(newSessionId) as { id: string | null }).id).toBeNull();

  w.engine.handleSignal(oldDispatch, {
    s: "session-started",
    adapterSessionId: "asid-late-old-dispatch",
  });
  expect((w.db.query(
    `SELECT adapter_session_id AS id FROM sessions WHERE id = ?1`,
  ).get(newSessionId) as { id: string | null }).id).toBeNull();
  expect(getCard(w.db, c.id)!.workingSub).toBe("starting");

  // If a later resume needs this fresh attempt, it must fall back to context
  // rather than resuming either identity from the superseded conversation.
  w.ptys.die(newSessionId, 1);
  await settle(w);
  expect(getCard(w.db, c.id)!.errorKind).toBe("crashed");
  await w.engine.resume(c.id);
  expect(w.adapter.spawns.at(-1)!.resumeSessionId ?? null).toBeNull();
  expect(w.adapter.spawns.at(-1)!.attempt.id).toBe(restarted.attemptId!);
});

// ---------------------------------------------------------------------------
// Discard + undo
// ---------------------------------------------------------------------------

test("discard archives the worktree (branch kept) and parks the card queued auto:false; undo restores fields only", async () => {
  const w = await makeWorld();
  const c = card(w, "discardable");
  const d = await toRunning(w, c);
  const sessId = agentSessionId(w, c.id);
  w.engine.handleSignal(d, { s: "stop-failure" }); // → error(crashed), session still live
  const wtId = getCard(w.db, c.id)!.worktreeId!;
  const wt = wtRows(w.db)[0]!;

  const out = await w.engine.discard(c.id);
  expect(out.phase).toBe("queued");
  expect(out.auto).toBe(false);
  expect(out.worktreeId).toBe(wtId); // pointer retained — the re-create pin
  expect(w.ptys.all.get(sessId)!.killed).toBe(true); // I3: archiving kills sessions
  expect(wtRows(w.db)[0]!.state).toBe("archived");
  expect(existsSync(wt.path)).toBe(false);
  const branches = await sh(w.repo, "git", "branch", "--list", `cg/${c.id}-*`);
  expect(branches).not.toBe(""); // branch kept (14-day policy)

  const undone = w.engine.undoDiscard(c.id);
  expect(undone.phase).toBe("working");
  expect(undone.workingSub).toBe("error");
  expect(undone.errorKind).toBe("crashed");
  expect(undone.auto).toBe(true); // restored
  expect(wtRows(w.db)[0]!.state).toBe("archived"); // fields only — worktree stays archived…
  expect(() => w.engine.undoDiscard(c.id)).toThrow(NothingToUndo); // one-shot

  // …and the next start re-creates the SAME worktree from the kept branch.
  await w.engine.restart(c.id);
  expect(getCard(w.db, c.id)!.worktreeId).toBe(wtId);
  expect(wtRows(w.db)[0]!.state).toBe("active");
  expect(existsSync(wt.path)).toBe(true);
});

test("a post-discard start invalidates the undo stash — stale undo cannot resurrect old state", async () => {
  const w = await makeWorld();
  const c = card(w, "stale undo");
  const d = await toRunning(w, c);
  w.engine.handleSignal(d, { s: "stop-failure" }); // → error(crashed)
  await w.engine.discard(c.id); // stash set, card parked queued auto:false

  // The user moves on: a manual start consumes the card's next life, and that
  // start FAILS — the card returns to queued(+start_failed)…
  w.adapter.behavior = "reject";
  await w.engine.start(c.id);
  expect(getCard(w.db, c.id)!.phase).toBe("queued");
  expect(getCard(w.db, c.id)!.errorKind).toBe("start_failed");

  // …where the STALE undo toast must not restore the pre-discard error card
  // (with its dead attempt/worktree pointers) over the fresh reality.
  expect(() => w.engine.undoDiscard(c.id)).toThrow(NothingToUndo);
});

test("resume/restart/discard are machine-guarded: legal only from working.error; unknown card 404-path", async () => {
  const w = await makeWorld();
  const c = card(w, "not in error", { auto: false });
  expect(w.engine.resume(c.id)).rejects.toThrow(IllegalTransition);
  expect(w.engine.restart(c.id)).rejects.toThrow(IllegalTransition);
  expect(w.engine.discard(c.id)).rejects.toThrow(IllegalTransition);
  expect(w.engine.resume(99999)).rejects.toThrow(CardNotFound);
});

// ---------------------------------------------------------------------------
// Settings-dir GC (review obligation 2) + boot-order dependence
// ---------------------------------------------------------------------------

test("sweepSettingsDirs: terminal + rowless dirs deleted, running kept, signal-plane files untouched", () => {
  const db = openDb(":memory:");
  const dataDir = mkTmp();
  const p = createProject(db, { name: "G", path: "/tmp", baseBranch: "main" });
  const c = createCard(db, { projectId: p.id, title: "gc", body: "", agent: "claude" });
  const att = createAttempt(db, { cardId: c.id, worktreeId: null, beforeHead: null });
  const dRun = createDispatch(db, att.id);
  const dDone = createDispatch(db, att.id);
  const dFail = createDispatch(db, att.id);
  completeDispatch(db, dDone.id, "done");
  completeDispatch(db, dFail.id, "failed");
  const agents = join(dataDir, "agents");
  for (const id of [dRun.id, dDone.id, dFail.id, "orphan-no-row"]) {
    mkdirSync(join(agents, id), { recursive: true });
    writeFileSync(join(agents, id, "settings.json"), "{}");
  }
  writeFileSync(join(agents, "hook.sh"), "#!/bin/sh\n");
  writeFileSync(join(agents, "endpoint.env"), "x=1\n");
  // The shared codex rollout store is durable (sessions/ = resume transcripts):
  mkdirSync(join(agents, "codex-home", "sessions"), { recursive: true });
  writeFileSync(join(agents, "codex-home", "sessions", "rollout-x.jsonl"), "{}\n");
  // A terminal codex dispatch dir carries a sessions SYMLINK into the store —
  // the sweep must remove the link with the dir, never the store behind it.
  symlinkSync(join(agents, "codex-home", "sessions"), join(agents, dDone.id, "sessions"));

  sweepSettingsDirs(db, dataDir);

  expect(existsSync(join(agents, dRun.id))).toBe(true); // running kept
  expect(existsSync(join(agents, dDone.id))).toBe(false); // terminal swept (incl. its symlink)
  expect(existsSync(join(agents, dFail.id))).toBe(false);
  expect(existsSync(join(agents, "orphan-no-row"))).toBe(false); // rowless dir is garbage
  expect(existsSync(join(agents, "hook.sh"))).toBe(true); // plane files never touched
  expect(existsSync(join(agents, "endpoint.env"))).toBe(true);
  expect(existsSync(join(agents, "codex-home", "sessions", "rollout-x.jsonl"))).toBe(true); // store exempt + un-followed

  sweepSettingsDirs(db, mkTmp()); // missing agents dir → no-op, no throw
});

test("boot order is load-bearing: reconcile-first makes the settings sweep total over pre-boot dirs", () => {
  const db = openDb(":memory:");
  const dataDir = mkTmp();
  const p = createProject(db, { name: "O", path: "/tmp", baseBranch: "main" });
  const c = createCard(db, { projectId: p.id, title: "order", body: "", agent: "claude" });
  updateCard(db, c.id, { phase: "working", workingSub: "running" });
  const att = createAttempt(db, { cardId: c.id, worktreeId: null, beforeHead: null });
  const d = createDispatch(db, att.id); // pre-boot dispatch, still `running`
  const dir = join(dataDir, "agents", d.id);
  mkdirSync(dir, { recursive: true });

  // Sweep BEFORE reconciliation would keep the stale dir (dispatch looks live).
  sweepSettingsDirs(db, dataDir);
  expect(existsSync(dir)).toBe(true);

  // Reconcile → the dispatch is terminal → the sweep now collects it.
  bootReconcile(db, { emit: () => {} }, Date.now());
  expect(dispatchStatus(db, d.id)).toBe("failed");
  sweepSettingsDirs(db, dataDir);
  expect(existsSync(dir)).toBe(false);
});

// ---------------------------------------------------------------------------
// HTTP routes — action mapping + interrupted banner data
// ---------------------------------------------------------------------------

test("recovery routes: 404 unknown / 409 illegal, discard responds {undo:true}, undo + resume flow, interrupted ids are project-scoped", async () => {
  const w = await makeWorld();
  const cfg = { port: 4930 + Math.floor(Math.random() * 60), dataDir: mkTmp(), token: "t9" };
  const srv = startServer(cfg, w.db, w.ptys as any, w.engine);
  const T = { headers: { "x-codegent-token": "t9", "content-type": "application/json" } };
  try {
    expect((await fetch(`${srv.url}api/cards/99999/resume`, { ...T, method: "POST" })).status).toBe(404);
    const q = card(w, "queued one", { auto: false });
    expect((await fetch(`${srv.url}api/cards/${q.id}/resume`, { ...T, method: "POST" })).status).toBe(409);
    expect((await fetch(`${srv.url}api/cards/${q.id}/restart`, { ...T, method: "POST" })).status).toBe(409);
    expect((await fetch(`${srv.url}api/cards/${q.id}/discard`, { ...T, method: "POST" })).status).toBe(409);
    expect((await fetch(`${srv.url}api/cards/${q.id}/undo-discard`, { ...T, method: "POST" })).status).toBe(409);

    // Interrupted banner: seed one interrupted card in each of two projects.
    const ic = card(w, "interruptee", { auto: false });
    updateCard(w.db, ic.id, { phase: "working", workingSub: "running" });
    const otherProject = createProject(w.db, { name: "Other", path: "/tmp", baseBranch: "main" });
    const otherCard = createCard(w.db, { projectId: otherProject.id, title: "other interruptee", body: "", agent: "none" });
    updateCard(w.db, otherCard.id, { phase: "working", workingSub: "running" });
    bootReconcile(w.db, { emit: () => {} }, Date.now());
    expect((await fetch(`${srv.url}api/state/interrupted`, T)).status).toBe(400);
    const banner = await fetch(`${srv.url}api/state/interrupted?project=${encodeURIComponent(w.project.id)}`, T);
    expect(banner.status).toBe(200);
    const bannerBody = (await banner.json()) as any;
    expect(bannerBody).toEqual({ cards: [ic.id] }); // ids only — no text fields
    const otherBanner = (await (await fetch(`${srv.url}api/state/interrupted?project=${encodeURIComponent(otherProject.id)}`, T)).json()) as any;
    expect(otherBanner).toEqual({ cards: [otherCard.id] });

    // discard → {undo:true}; undo-discard → restored error card; resume → starting.
    const c = card(w, "errored");
    const d = await toRunning(w, c);
    w.engine.handleSignal(d, { s: "stop-failure" });
    const r = await fetch(`${srv.url}api/cards/${c.id}/discard`, { ...T, method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.undo).toBe(true);
    expect(body.card.phase).toBe("queued");
    expect(body.card.auto).toBe(false);
    const u = await fetch(`${srv.url}api/cards/${c.id}/undo-discard`, { ...T, method: "POST" });
    expect(u.status).toBe(200);
    expect(((await u.json()) as any).errorKind).toBe("crashed");
    const rr = await fetch(`${srv.url}api/cards/${c.id}/resume`, { ...T, method: "POST" });
    expect(rr.status).toBe(200);
    expect(((await rr.json()) as any).workingSub).toBe("starting");
    // A resumed card leaves the banner set; the untouched one stays.
    const after = (await (await fetch(`${srv.url}api/state/interrupted?project=${encodeURIComponent(w.project.id)}`, T)).json()) as any;
    expect(after.cards).toEqual([ic.id]);
  } finally {
    srv.stop();
  }
}, 15_000);
