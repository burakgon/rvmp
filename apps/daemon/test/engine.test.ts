import { test, expect, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, DomainEvent, Project, SessionMeta, Worktree } from "@codegent/protocol";
import { openDb } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { createCard, getCard, updateCard } from "../src/store/cards";
import { listReviewedFiles, setReviewed } from "../src/store/reviews";
import { markPendingComplete, touchDispatchProgress } from "../src/store/attempts";
import { insertSession, setSessionLive } from "../src/store/sessions";
import { appendTimeline, listTimeline } from "../src/store/timeline";
import { createWorktree as createManagedWorktree } from "../src/git/worktrees";
import type { OpenSessionOpts } from "../src/pty/manager";
import type { AgentAdapter, AdapterSignal, SpawnCtx, SpawnResult } from "../src/agents/types";
import { normalizeUniversalState } from "../src/agents/universal";
import { ActionInProgress, Engine, NotStartable, type EngineDeps } from "../src/orchestrator/engine";
import { IllegalTransition } from "../src/orchestrator/machine";

// ---------------------------------------------------------------------------
// Harness: tmp git repos, FakePtys (insertSession like the real manager, so
// the engine's DB session lookups work), FakeAdapter with scripted behavior,
// injected clock — NO real sleeps drive any timer assertion.
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});

const sh = async (cwd: string, ...cmd: string[]): Promise<string> => {
  const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited, new Response(p.stdout).text(), new Response(p.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
};

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "cg-eng-"));
  cleanups.push(repo);
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
  private resolveExit!: (n: number) => void;
  readonly exited = new Promise<number>((res) => (this.resolveExit = res));
  constructor(private onDead: () => void) {}
  write(d: Uint8Array | string): void {
    this.writes.push(typeof d === "string" ? d : new TextDecoder().decode(d));
  }
  terminate(): Promise<number> {
    if (!this.killed) {
      this.killed = true;
      this.onDead();
      this.resolveExit(0);
    }
    return this.exited;
  }
  finish(code: number): void {
    if (this.killed) return;
    this.killed = true;
    this.onDead();
    this.resolveExit(code);
  }
}

class FakePtys {
  all = new Map<string, FakeSess>();
  constructor(private db: Database) {}
  open(opts: OpenSessionOpts): SessionMeta {
    const id = `fp-${this.all.size + 1}-${crypto.randomUUID().slice(0, 4)}`;
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
  /** Test helper: the session died on its own (user typed exit, crash, …). */
  die(id: string): void {
    const s = this.all.get(id);
    if (s) {
      s.killed = true;
      setSessionLive(this.db, id, false);
    }
  }
  /** Test helper: resolve the real exit promise so engine supervision runs. */
  exit(id: string, code: number): void {
    this.all.get(id)?.finish(code);
  }
}

class FakeAdapter implements AgentAdapter {
  behavior: "ok" | "reject" | "hang" = "ok";
  spawns: SpawnCtx[] = [];
  constructor(private ptys: FakePtys, readonly agent: string = "claude") {}
  async spawn(ctx: SpawnCtx): Promise<SpawnResult> {
    this.spawns.push(ctx);
    if (this.behavior === "reject") throw new Error("spawn failed (scripted)");
    if (this.behavior === "hang") return new Promise<SpawnResult>(() => {});
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
  /** Registered only when makeWorld is asked for one (registry tests). */
  codex: FakeAdapter | null;
  /** Shared universal adapter, registered for Gemini when requested. */
  universal: FakeAdapter | null;
  events: DomainEvent[];
  engine: Engine;
  advance: (ms: number) => void;
}

async function makeWorld(opts?: {
  spawnTimeoutMs?: number;
  mismatchWatchdogMs?: number;
  codex?: boolean;
  universal?: boolean;
  createWorktree?: EngineDeps["createWorktree"];
  rematerializeWorktree?: EngineDeps["rematerializeWorktree"];
  prRunner?: EngineDeps["prRunner"];
}): Promise<World> {
  const db = openDb(":memory:");
  const repo = await makeRepo();
  const project = createProject(db, { name: "E", path: repo, baseBranch: "main" });
  const ptys = new FakePtys(db);
  const adapter = new FakeAdapter(ptys);
  const codex = opts?.codex ? new FakeAdapter(ptys, "codex") : null;
  const universal = opts?.universal ? new FakeAdapter(ptys, "universal") : null;
  const events: DomainEvent[] = [];
  let offset = 0;
  const engine = new Engine({
    db, ptys,
    adapters: { claude: adapter, codex, gemini: universal },
    events: { emit: (e) => events.push(e) },
    clock: () => Date.now() + offset,
    timers: {
      spawnTimeoutMs: opts?.spawnTimeoutMs ?? 5_000,
      injectSettleMs: 1,
      ...(opts?.mismatchWatchdogMs === undefined
        ? {}
        : { mismatchWatchdogMs: opts.mismatchWatchdogMs }),
    },
    createWorktree: opts?.createWorktree,
    rematerializeWorktree: opts?.rematerializeWorktree,
    prRunner: opts?.prRunner,
  });
  return {
    db, repo, project, ptys, adapter, codex, universal, events, engine,
    advance: (ms) => (offset += ms),
  };
}

const card = (w: World, title: string, over: Partial<Pick<Card, "agent" | "auto">> = {}): Card => {
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

const attemptRows = (db: Database, cardId: number): Array<{ seq: number; status: string; before_head: string | null; worktree_id: string | null }> =>
  db.query(`SELECT seq, status, before_head, worktree_id FROM attempts WHERE card_id = ?1 ORDER BY seq`).all(cardId) as any;

const wtRows = (db: Database): Array<Worktree & { state: string }> =>
  db.query(`SELECT * FROM worktrees`).all().map((r: any) => ({
    id: r.id, projectId: r.project_id, branch: r.branch, path: r.path, base: r.base, state: r.state,
  })) as any;

/** Drive one card queued → working.running through the real start path. */
async function toRunning(
  w: World,
  c: Card,
  adapterSessionId: string | null = `asid-${c.id}`,
): Promise<string> {
  await w.engine.start(c.id);
  const d = dispatchOf(w.db, c.id);
  w.engine.handleSignal(d.id, { s: "session-started", adapterSessionId });
  expect(getCard(w.db, c.id)!.workingSub).toBe("running");
  return d.id;
}

const agentSessionId = (w: World, cardId: number): string => {
  const c = getCard(w.db, cardId)!;
  const row = w.db.query(
    `SELECT id FROM sessions WHERE attempt_id = ?1 AND kind = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(c.attemptId) as any;
  return row.id;
};

function exitBeforeSpawnRegistration(
  w: World,
  adapter: FakeAdapter,
  code: number,
  adapterSessionId: string | null,
): void {
  const spawn = adapter.spawn.bind(adapter);
  adapter.spawn = async (ctx) => {
    const result = await spawn(ctx);
    ctx.emitSignal?.({ s: "session-started", adapterSessionId });
    const session = w.ptys.all.get(result.sessionMeta.id)!;
    w.ptys.exit(result.sessionMeta.id, code);
    await session.exited;
    return result;
  };
}

// ---------------------------------------------------------------------------
// R1 scheduling
// ---------------------------------------------------------------------------

test("R1 starts the topmost auto:on startable card only while slots are free", async () => {
  const w = await makeWorld();
  const none = card(w, "no agent", { agent: "none" }); // position 1 — R1 must skip
  const off = card(w, "backlog", { auto: false }); // position 2 — auto:off skipped
  const c1 = card(w, "first real");
  const c2 = card(w, "second real");

  w.engine.tick();
  await w.engine.idle();

  expect(w.adapter.spawns.length).toBe(1);
  expect(w.adapter.spawns[0]!.card.id).toBe(c1.id);
  expect(getCard(w.db, c1.id)!.workingSub).toBe("starting");
  expect(getCard(w.db, c2.id)!.phase).toBe("queued");
  expect(getCard(w.db, none.id)!.phase).toBe("queued");
  expect(getCard(w.db, off.id)!.phase).toBe("queued");

  // Slot still occupied (starting counts): nothing new.
  w.engine.tick();
  await w.engine.idle();
  expect(w.adapter.spawns.length).toBe(1);

  // Raise the worker limit → next topmost starts.
  w.db.query(`UPDATE projects SET worker_limit = 2 WHERE id = ?1`).run(w.project.id);
  w.engine.tick();
  await w.engine.idle();
  expect(w.adapter.spawns.length).toBe(2);
  expect(w.adapter.spawns[1]!.card.id).toBe(c2.id);
});

test("an early SessionStart is persisted after adapter spawn registration completes", async () => {
  const w = await makeWorld();
  const c = card(w, "early session");
  const spawn = w.adapter.spawn.bind(w.adapter);
  w.adapter.spawn = async (ctx) => {
    const result = await spawn(ctx);
    w.engine.handleSignal(ctx.dispatch.id, {
      s: "session-started",
      adapterSessionId: "early-adapter-session",
    });
    return result;
  };

  await w.engine.start(c.id);

  const row = w.db.query(
    `SELECT adapter_session_id AS id FROM sessions WHERE attempt_id = ?1`,
  ).get(getCard(w.db, c.id)!.attemptId) as { id: string | null };
  expect(row.id).toBe("early-adapter-session");
});

test("R1 registry: a queued codex card auto-starts through the CODEX adapter; without one it stays queued", async () => {
  // Default world: codex has NO registered adapter → R1 must not pick it up.
  const w0 = await makeWorld();
  const parked = card(w0, "codex parked", { agent: "codex" });
  w0.engine.tick();
  await w0.engine.idle();
  expect(getCard(w0.db, parked.id)!.phase).toBe("queued");
  expect(w0.adapter.spawns.length).toBe(0);

  // Codex registered: tick routes the card through adapterFor("codex"), never
  // the claude adapter, and the usual session-started drive applies.
  const w = await makeWorld({ codex: true });
  const c = card(w, "codex card", { agent: "codex" });
  w.engine.tick();
  await w.engine.idle();
  expect(w.codex!.spawns.length).toBe(1);
  expect(w.codex!.spawns[0]!.card.id).toBe(c.id);
  expect(w.adapter.spawns.length).toBe(0);
  const d = dispatchOf(w.db, c.id);
  w.engine.handleSignal(d.id, { s: "session-started", adapterSessionId: `codex-${c.id}` });
  expect(getCard(w.db, c.id)!.workingSub).toBe("running");
});

test("manual start of a none-agent card is rejected (NotStartable) and non-queued start is IllegalTransition", async () => {
  const w = await makeWorld();
  const none = card(w, "manual none", { agent: "none" });
  expect(w.engine.start(none.id)).rejects.toThrow(NotStartable);

  const c = card(w, "real");
  await w.engine.start(c.id);
  expect(w.engine.start(c.id)).rejects.toThrow(IllegalTransition);
});

// ---------------------------------------------------------------------------
// Happy path + envelope
// ---------------------------------------------------------------------------

test("full happy path: queued → starting → running → review.ready via completeFromApi, R1 pulls the next card", async () => {
  const w = await makeWorld();
  const c1 = card(w, "Card A");
  const c2 = card(w, "Card B");

  w.engine.tick();
  await w.engine.idle();

  // Envelope: worktree + attempt(beforeHead) + dispatch, card wired to them.
  const head = await sh(w.repo, "git", "rev-parse", "HEAD");
  const c1s = getCard(w.db, c1.id)!;
  expect(c1s.workingSub).toBe("starting");
  expect(c1s.worktreeId).not.toBeNull();
  expect(c1s.attemptId).not.toBeNull();
  const [a1] = attemptRows(w.db, c1.id);
  expect(a1!.before_head).toBe(head);
  expect(a1!.worktree_id).toBe(c1s.worktreeId!);
  const wt = wtRows(w.db).find((x) => x.id === c1s.worktreeId)!;
  expect(wt.branch.startsWith(`cg/${c1.id}-`)).toBe(true);
  expect(existsSync(wt.path)).toBe(true);
  const d1 = dispatchOf(w.db, c1.id);
  expect(d1.status).toBe("running");

  // SessionStart hook → running + adapter session id recorded on the session row.
  w.engine.handleSignal(d1.id, { s: "session-started", adapterSessionId: "asid-live" });
  expect(getCard(w.db, c1.id)!.workingSub).toBe("running");
  const sessRow = w.db.query(`SELECT adapter_session_id FROM sessions WHERE id = ?1`).get(agentSessionId(w, c1.id)) as any;
  expect(sessRow.adapter_session_id).toBe("asid-live");

  // Completion via the agent API path.
  markPendingComplete(w.db, d1.id);
  w.engine.completeFromApi(d1.id);
  await w.engine.idle();

  const done = getCard(w.db, c1.id)!;
  expect(done.phase).toBe("review");
  expect(done.reviewSub).toBe("ready");
  expect(done.readySince).toBeNumber();
  expect(done.readySince).toBeGreaterThan(0);
  expect((dispatchOf(w.db, c1.id)).status).toBe("done");
  expect(attemptRows(w.db, c1.id)[0]!.status).toBe("succeeded");

  // R4→R1: the freed slot pulled c2.
  expect(getCard(w.db, c2.id)!.phase).toBe("working");
  expect(w.adapter.spawns.length).toBe(2);

  // Events: card transitions + one attempt event, and NO text-bearing payloads.
  expect(w.events.some((e) => e.t === "attempt")).toBe(true);
  expect(w.events.some((e) => e.t === "card" && e.card.id === c1.id && e.card.phase === "review")).toBe(true);
});

test("a second completeFromApi on the same dispatch is stale — ignored by the write-once latch", async () => {
  const w = await makeWorld();
  const c = card(w, "once");
  const d = await toRunning(w, c);
  w.engine.completeFromApi(d);
  expect(getCard(w.db, c.id)!.phase).toBe("review");
  const eventsBefore = w.events.length;
  const attemptsBefore = attemptRows(w.db, c.id);

  w.engine.completeFromApi(d); // stale retry
  expect(w.events.length).toBe(eventsBefore);
  expect(getCard(w.db, c.id)!.phase).toBe("review");
  expect(attemptRows(w.db, c.id)).toEqual(attemptsBefore);
});

test("illegal completion and StopFailure signals leave the dispatch latch and starting card untouched", async () => {
  const w = await makeWorld();
  const c = card(w, "not running yet");
  await w.engine.start(c.id); // adapter spawned, SessionStart has not arrived
  const d = dispatchOf(w.db, c.id);
  const before = getCard(w.db, c.id)!;
  const eventsBefore = w.events.length;

  markPendingComplete(w.db, d.id);
  w.engine.handleSignal(d.id, { s: "complete-eval" });
  w.engine.handleSignal(d.id, { s: "stop-failure" });

  expect(dispatchOf(w.db, c.id).status).toBe("running");
  expect(attemptRows(w.db, c.id)[0]!.status).toBe("running");
  expect(getCard(w.db, c.id)).toEqual(before);
  expect(w.events.length).toBe(eventsBefore);
});

// ---------------------------------------------------------------------------
// Signals: flags, truth table, stop-failure, staleness
// ---------------------------------------------------------------------------

test("question flag → Waiting projection → flag-clear resumes", async () => {
  const w = await makeWorld();
  const c = card(w, "asker");
  const d = await toRunning(w, c);

  w.engine.handleSignal(d, { s: "flag", kind: "question" });
  let cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("working");
  expect(cur.workingSub).toBe("running");
  expect(cur.inputKind).toBe("question"); // the Waiting column projection
  expect(cur.inputSince).not.toBeNull();

  w.engine.handleSignal(d, { s: "flag-clear" });
  cur = getCard(w.db, c.id)!;
  expect(cur.inputKind).toBeNull();
  expect(cur.inputSince).toBeNull();
});

test("universal idle without task_complete closes the silent wedge into Waiting+silent", async () => {
  const w = await makeWorld({ universal: true });
  const c = card(w, "gemini idle", { agent: "gemini" });
  const d = await toRunning(w, c, null);

  expect(w.universal?.spawns.map((spawn) => spawn.card.id)).toEqual([c.id]);
  expect(w.adapter.spawns).toHaveLength(0);

  const signals = normalizeUniversalState(
    { agent: "gemini", state: "idle", since: 1_000 },
    { assigned: true, taskCompleteReceived: false },
  );
  for (const signal of signals) w.engine.handleSignal(d, signal);

  const waiting = getCard(w.db, c.id)!;
  expect(waiting.phase).toBe("working");
  expect(waiting.workingSub).toBe("running");
  expect(waiting.inputKind).toBe("silent");
});

test("A1: idle re-emits after live send-back resets the dispatch dedup baseline", async () => {
  const w = await makeWorld({ universal: true });
  const c = card(w, "gemini round-two idle", { agent: "gemini" });
  const adapter = w.universal!;
  const spawn = adapter.spawn.bind(adapter);
  const idle = { agent: "gemini", state: "idle", since: 1_000 } as const;
  let activeCtx: SpawnCtx | null = null;
  let lastPublished: typeof idle | null = null;
  adapter.spawn = async (ctx) => {
    activeCtx = ctx;
    return {
      ...(await spawn(ctx)),
      resetDispatchState: () => {
        lastPublished = null;
      },
      markTaskSubmitted: () => {},
    };
  };
  const publishIdle = (): void => {
    if (lastPublished === idle) return;
    lastPublished = idle;
    activeCtx?.emitSignal?.({ s: "flag", kind: "silent" });
  };

  const d1 = await toRunning(w, c, null);
  publishIdle();
  expect(getCard(w.db, c.id)!.inputKind).toBe("silent");
  w.engine.completeFromApi(d1);
  await w.engine.sendBack(c.id, ["one more pass"]);

  const d2 = dispatchOf(w.db, c.id);
  expect(d2.id).not.toBe(d1);
  publishIdle(); // same DetectState object as round 1

  const waiting = getCard(w.db, c.id)!;
  expect(waiting.phase).toBe("working");
  expect(waiting.workingSub).toBe("running");
  expect(waiting.inputKind).toBe("silent");
  expect(d2.status).toBe("running"); // no task_complete: I1 remains closed
});

test("universal task_complete keeps I1 intact and moves the card to review", async () => {
  const w = await makeWorld({ universal: true });
  const c = card(w, "gemini complete", { agent: "gemini" });
  const d = await toRunning(w, c, null);

  expect(markPendingComplete(w.db, d)).toBe(true);
  w.engine.completeFromApi(d);

  const completed = getCard(w.db, c.id)!;
  expect(completed.phase).toBe("review");
  expect(completed.reviewSub).toBe("ready");
  expect(completed.inputKind).toBeNull();
});

test("universal process exit without task_complete uses the existing crash path", async () => {
  const w = await makeWorld({ universal: true });
  const c = card(w, "gemini exits", { agent: "gemini" });
  await toRunning(w, c, null);
  const sessionId = agentSessionId(w, c.id);
  const exited = w.ptys.all.get(sessionId)!.exited;

  w.ptys.exit(sessionId, 0);
  await exited;
  await Promise.resolve();

  const failed = getCard(w.db, c.id)!;
  expect(failed.workingSub).toBe("error");
  expect(failed.errorKind).toBe("crashed");
  expect(dispatchOf(w.db, c.id).status).toBe("failed");
});

test("R1 regression: premium clean exit before spawn registration is not crashed", async () => {
  const w = await makeWorld();
  const c = card(w, "claude clean exit before observer");
  exitBeforeSpawnRegistration(w, w.adapter, 0, `claude-${c.id}`);

  await w.engine.start(c.id);
  await Promise.resolve();

  const clean = getCard(w.db, c.id)!;
  expect(clean.workingSub).toBe("running");
  expect(clean.errorKind).toBeNull();
  expect(dispatchOf(w.db, c.id).status).toBe("running");
});

test("R1 regression: premium nonzero exit before spawn registration still crashes", async () => {
  const w = await makeWorld();
  const c = card(w, "claude crash before observer");
  exitBeforeSpawnRegistration(w, w.adapter, 17, `claude-${c.id}`);

  await w.engine.start(c.id);
  await Promise.resolve();

  const failed = getCard(w.db, c.id)!;
  expect(failed.workingSub).toBe("error");
  expect(failed.errorKind).toBe("crashed");
  expect(dispatchOf(w.db, c.id).status).toBe("failed");
});

test("A2: universal exit before spawn registration is reconciled through the crash path", async () => {
  const w = await makeWorld({ universal: true });
  const c = card(w, "gemini exits before observer", { agent: "gemini" });
  exitBeforeSpawnRegistration(w, w.universal!, 0, null);

  await w.engine.start(c.id);
  await Promise.resolve();

  const failed = getCard(w.db, c.id)!;
  expect(failed.workingSub).toBe("error");
  expect(failed.errorKind).toBe("crashed");
  expect(dispatchOf(w.db, c.id).status).toBe("failed");
});

test("universal classifier gone verdict uses the existing crash path", async () => {
  const w = await makeWorld({ universal: true });
  const c = card(w, "gemini disappears", { agent: "gemini" });
  await toRunning(w, c, null);

  w.universal!.spawns[0]!.reportProcessGone?.();

  const failed = getCard(w.db, c.id)!;
  expect(failed.workingSub).toBe("error");
  expect(failed.errorKind).toBe("crashed");
  expect(dispatchOf(w.db, c.id).status).toBe("failed");
});

test("B1: universal manual-running versus detected idle emits one mismatch after the threshold", async () => {
  const w = await makeWorld({ universal: true, mismatchWatchdogMs: 1_000 });
  const c = card(w, "gemini override disagrees", { agent: "gemini" });
  const adapter = w.universal!;
  const spawn = adapter.spawn.bind(adapter);
  const detected = { state: "idle", since: Date.now() } as const;
  adapter.spawn = async (ctx) => ({
    ...(await spawn(ctx)),
    latestDetectState: () => detected,
  });
  await toRunning(w, c, null);
  await w.engine.markState(c.id, "running");

  w.engine.interval();
  w.advance(1_001);
  w.engine.interval();
  w.engine.interval();

  const mismatches = w.events.filter(
    (event) => event.t === "notice" && event.kind === "mismatch" && event.cardId === c.id,
  );
  expect(mismatches).toHaveLength(1);
  expect(getCard(w.db, c.id)!.inputKind).toBeNull();
});

test("B2 regression: suppressed permission-to-question change stays single-emit", async () => {
  const w = await makeWorld({ mismatchWatchdogMs: 1_000 });
  const c = card(w, "claude permission override");
  const dispatch = await toRunning(w, c);
  await w.engine.markState(c.id, "running");

  w.engine.handleSignal(dispatch, { s: "flag", kind: "permission" });
  expect(getCard(w.db, c.id)!.inputKind).toBeNull(); // override still owns display state
  w.engine.interval();
  w.advance(1_001);
  w.engine.interval();
  w.engine.interval();

  // This remains one continuous manual-running-versus-waiting disagreement.
  w.engine.handleSignal(dispatch, { s: "flag", kind: "question" });
  w.advance(1_001);
  w.engine.interval();
  w.engine.interval();

  const mismatches = w.events.filter(
    (event) => event.t === "notice" && event.kind === "mismatch" && event.cardId === c.id,
  );
  expect(mismatches).toEqual([{ t: "notice", cardId: c.id, kind: "mismatch" }]);
  expect(Object.keys(mismatches[0]!).sort()).toEqual(["cardId", "kind", "t"]);
});

test("Stop without pending completion flags question (truth table); with the marker it completes", async () => {
  const w = await makeWorld();
  const c = card(w, "stops");
  const d = await toRunning(w, c);

  w.engine.handleSignal(d, { s: "complete-eval" }); // Stop, no task_complete
  expect(getCard(w.db, c.id)!.inputKind).toBe("question");
  expect(getCard(w.db, c.id)!.phase).toBe("working");

  markPendingComplete(w.db, d);
  w.engine.handleSignal(d, { s: "complete-eval" }); // Stop after task_complete
  expect(getCard(w.db, c.id)!.phase).toBe("review");
  expect(dispatchOf(w.db, c.id).status).toBe("done");
});

test("StopFailure → error(crashed), attempt failed, dispatch failed", async () => {
  const w = await makeWorld();
  const c = card(w, "api error");
  const d = await toRunning(w, c);

  w.engine.handleSignal(d, { s: "stop-failure" });
  const cur = getCard(w.db, c.id)!;
  expect(cur.workingSub).toBe("error");
  expect(cur.errorKind).toBe("crashed");
  expect(dispatchOf(w.db, c.id).status).toBe("failed");
  expect(attemptRows(w.db, c.id)[0]!.status).toBe("failed");
});

test("StopFailure refills a workerLimit 1 slot without an explicit tick", async () => {
  const w = await makeWorld();
  const a = card(w, "A fails");
  const b = card(w, "B follows");
  const dispatch = await toRunning(w, a);
  expect(getCard(w.db, b.id)!.phase).toBe("queued");

  w.engine.handleSignal(dispatch, { s: "stop-failure" });
  await w.engine.idle();

  expect(getCard(w.db, a.id)!.workingSub).toBe("error");
  expect(getCard(w.db, b.id)!.phase).toBe("working");
  expect(w.adapter.spawns.at(-1)!.card.id).toBe(b.id);
});

test("signals for a non-running dispatch are dropped (stale prior-dispatch hooks die naturally)", async () => {
  const w = await makeWorld();
  const c = card(w, "stale");
  const d = await toRunning(w, c);
  w.engine.completeFromApi(d); // dispatch → done
  await w.engine.idle();
  const snapshot = getCard(w.db, c.id)!;
  const eventsBefore = w.events.length;

  w.engine.handleSignal(d, { s: "flag", kind: "permission" });
  w.engine.handleSignal(d, { s: "stop-failure" });
  w.engine.handleSignal("no-such-dispatch", { s: "flag", kind: "question" });

  expect(getCard(w.db, c.id)!).toEqual(snapshot);
  expect(w.events.length).toBe(eventsBefore);
});

// ---------------------------------------------------------------------------
// Circuit breaker + spawn timeout
// ---------------------------------------------------------------------------

test("a slot release inside A's active start lease immediately starts unlocked card B", async () => {
  const w = await makeWorld();
  const a = card(w, "A fails while leased");
  const b = card(w, "B must start immediately");
  const spawn = w.adapter.spawn.bind(w.adapter);
  let rejectFirstA = true;
  w.adapter.spawn = async (ctx) => {
    if (ctx.card.id !== a.id || !rejectFirstA) return spawn(ctx);
    rejectFirstA = false;
    w.adapter.behavior = "reject";
    try {
      return await spawn(ctx);
    } finally {
      w.adapter.behavior = "ok";
    }
  };

  const tick = w.engine.tick.bind(w.engine);
  const passes: Array<{ aLeaseHeld: boolean; bPhase: Card["phase"] }> = [];
  w.engine.tick = () => {
    const aLeaseHeld = (w.engine as unknown as {
      activeActions: Map<number, unknown>;
    }).activeActions.has(a.id);
    tick();
    passes.push({ aLeaseHeld, bPhase: getCard(w.db, b.id)!.phase });
  };

  await w.engine.start(a.id);
  await w.engine.idle();

  expect(passes[0]).toEqual({ aLeaseHeld: true, bPhase: "working" });
  expect(getCard(w.db, a.id)!.phase).toBe("queued");
  expect(getCard(w.db, b.id)!.phase).toBe("working");
  expect(w.adapter.spawns.map((ctx) => ctx.card.id)).toEqual([a.id, b.id]);
});

test("3 consecutive spawn failures trip the breaker: auto:false, R1 stops picking", async () => {
  const w = await makeWorld();
  w.adapter.behavior = "reject";
  const c = card(w, "cursed");

  w.engine.tick();
  await w.engine.idle();

  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("queued");
  expect(cur.errorKind).toBe("start_failed");
  expect(cur.auto).toBe(false); // breaker forced auto off
  expect(attemptRows(w.db, c.id).map((a) => a.status)).toEqual(["failed", "failed", "failed"]);
  // Each retry is the pending same-card wake replayed after the prior start
  // lease releases; the breaker stops the chain after the third failure.
  expect(w.adapter.spawns.map((ctx) => ctx.card.id)).toEqual([c.id, c.id, c.id]);

  // R1 never picks it up again.
  w.engine.tick();
  await w.engine.idle();
  expect(w.adapter.spawns.length).toBe(3);
});

test("spawn timeout → start_failed + partial-worktree rollback (branch and row gone, retry stays clean)", async () => {
  const w = await makeWorld({ spawnTimeoutMs: 40 });
  w.adapter.behavior = "hang";
  const c = card(w, "slow spawn");

  w.engine.tick();
  await w.engine.idle(); // breaker runs the 3-attempt chain, each timing out

  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("queued");
  expect(cur.errorKind).toBe("start_failed");
  expect(cur.auto).toBe(false);
  expect(cur.worktreeId).toBeNull(); // partial rollback cleared the card's pointer
  expect(wtRows(w.db).length).toBe(0); // rows rolled back, not archived
  const branches = await sh(w.repo, "git", "branch", "--list", `cg/${c.id}-*`);
  expect(branches).toBe(""); // branch deleted — a failed start leaves no residue
}, 15_000);

test("action mutex blocks cancel during slow worktree creation; later cancel archives cleanly", async () => {
  let created!: () => void;
  let release!: () => void;
  const worktreeCreated = new Promise<void>(resolve => (created = resolve));
  const continueCreation = new Promise<void>(resolve => (release = resolve));
  const w = await makeWorld({
    createWorktree: async (db, project, opts) => {
      const wt = await createManagedWorktree(db, project, opts);
      created();
      await continueCreation;
      return wt;
    },
  });
  const c = card(w, "slow worktree");

  const start = w.engine.start(c.id);
  await worktreeCreated;
  expect(wtRows(w.db)).toHaveLength(1); // created, but not yet wired to the card
  const lease = (w.engine as unknown as {
    activeActions: Map<number, unknown>;
  }).activeActions.get(c.id) as Record<string, unknown>;
  expect(Object.keys(lease)).toEqual(["action"]);
  await expect(w.engine.markState(c.id, "running")).rejects.toThrow(ActionInProgress);
  await expect(w.engine.cancel(c.id)).rejects.toThrow(ActionInProgress);
  expect(getCard(w.db, c.id)!.workingSub).toBe("starting");

  release();
  await start;
  expect(getCard(w.db, c.id)!.worktreeId).not.toBeNull();
  expect(wtRows(w.db)[0]!.state).toBe("active");
  expect(existsSync(wtRows(w.db)[0]!.path)).toBe(true);

  await w.engine.cancel(c.id); // lease released after start settled

  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("cancelled");
  expect(wtRows(w.db)[0]!.state).toBe("archived");
  expect(existsSync(wtRows(w.db)[0]!.path)).toBe(false);
  expect(await sh(w.repo, "git", "branch", "--list", `cg/${c.id}-*`)).not.toBe("");
}, 15_000);

test("action mutex blocks cancel during retained-worktree re-materialization", async () => {
  let materialized!: () => void;
  let release!: () => void;
  const worktreeMaterialized = new Promise<void>(resolve => (materialized = resolve));
  const continueMaterialization = new Promise<void>(resolve => (release = resolve));
  const w = await makeWorld({
    rematerializeWorktree: async (project, wt) => {
      await sh(project.path, "git", "worktree", "add", wt.path, wt.branch);
      materialized();
      await continueMaterialization;
    },
  });
  const c = card(w, "retained worktree");
  const dispatch = await toRunning(w, c);
  const wt = wtRows(w.db)[0]!;
  w.engine.handleSignal(dispatch, { s: "stop-failure" });
  await w.engine.discard(c.id);
  w.engine.undoDiscard(c.id);
  expect(wtRows(w.db)[0]!.state).toBe("archived");
  expect(existsSync(wt.path)).toBe(false);

  const resume = w.engine.resume(c.id);
  await worktreeMaterialized;
  expect(existsSync(wt.path)).toBe(true);
  await expect(w.engine.cancel(c.id)).rejects.toThrow(ActionInProgress);

  release();
  await resume;
  expect(wtRows(w.db)[0]!.state).toBe("active");
  expect(existsSync(wt.path)).toBe(true);

  await w.engine.cancel(c.id); // resume lease released

  expect(getCard(w.db, c.id)!.phase).toBe("cancelled");
  expect(wtRows(w.db)[0]!.state).toBe("archived");
  expect(existsSync(wt.path)).toBe(false);
  expect(await sh(w.repo, "git", "branch", "--list", wt.branch)).not.toBe("");
}, 15_000);

// ---------------------------------------------------------------------------
// Heartbeat + runaway (fake clock only)
// ---------------------------------------------------------------------------

test("heartbeat-quiet notice at +10min once per quiet period; runaway at +30min exactly once", async () => {
  const w = await makeWorld();
  const c = card(w, "quiet one");
  const d = await toRunning(w, c);
  const notices = () => w.events.filter((e) => e.t === "notice") as Array<{ t: "notice"; cardId: number; kind: string }>;

  w.engine.interval();
  expect(notices().length).toBe(0);

  w.advance(11 * 60_000); // +11min, no progress
  w.engine.interval();
  expect(notices().map((n) => n.kind)).toEqual(["heartbeat-quiet"]);
  w.engine.interval(); // same quiet period → no duplicate
  expect(notices().length).toBe(1);

  // Progress resumes, then goes quiet again → a second notice for the new period.
  touchDispatchProgress(w.db, d, Date.now() + 11 * 60_000);
  w.advance(12 * 60_000); // quiet ≈ 12min since the touch
  w.engine.interval();
  expect(notices().filter((n) => n.kind === "heartbeat-quiet").length).toBe(2);

  w.advance(9 * 60_000); // dispatch age ≈ 32min → runaway
  w.engine.interval();
  expect(notices().filter((n) => n.kind === "runaway").length).toBe(1);
  w.engine.interval();
  expect(notices().filter((n) => n.kind === "runaway").length).toBe(1); // once
  expect(notices().every((n) => n.cardId === c.id)).toBe(true);
});

// ---------------------------------------------------------------------------
// Merge (real git squash) — atomicity, branch reset, archive, R4
// ---------------------------------------------------------------------------

test("merge squashes onto base, resets the cg branch, kills sessions, archives the worktree; git failure leaves the card in review.ready", async () => {
  const w = await makeWorld();
  const c = card(w, "Ship feature");
  const other = card(w, "Other review", { auto: false });
  const d = await toRunning(w, c);

  // Real committed work on the cg branch.
  const wt = wtRows(w.db).find((x) => x.id === getCard(w.db, c.id)!.worktreeId)!;
  await Bun.write(join(wt.path, "feature.txt"), "shipped\n");
  await sh(wt.path, "git", "add", "-A");
  await sh(wt.path, "git", "commit", "-m", "wip 1");
  await Bun.write(join(wt.path, "feature.txt"), "shipped v2\n");
  await sh(wt.path, "git", "add", "-A");
  await sh(wt.path, "git", "commit", "-m", "wip 2");

  w.engine.completeFromApi(d);
  await w.engine.idle();
  expect(getCard(w.db, c.id)!.reviewSub).toBe("ready");
  updateCard(w.db, other.id, { phase: "review", reviewSub: "ready" }); // a second review card for R4

  // ATOMICITY: main checkout not on base → the whole merge refuses, card untouched.
  await sh(w.repo, "git", "checkout", "-b", "elsewhere");
  expect(w.engine.merge(c.id)).rejects.toThrow(/elsewhere/);
  expect(getCard(w.db, c.id)!.reviewSub).toBe("ready"); // never left ready — no merging trap
  expect(getCard(w.db, c.id)!.phase).toBe("review");
  await sh(w.repo, "git", "checkout", "main");

  const evBefore = w.events.length;
  const liveAgent = agentSessionId(w, c.id);
  await w.engine.merge(c.id);

  // One squash commit landed on base, carrying the card title.
  const subject = await sh(w.repo, "git", "log", "--format=%s", "-n", "1", "main");
  expect(subject).toContain("Ship feature");
  expect(subject).toContain(String(c.id));
  const mainSha = await sh(w.repo, "git", "rev-parse", "main");
  const branchSha = await sh(w.repo, "git", "rev-parse", wt.branch);
  expect(branchSha).toBe(mainSha); // VK: branch ref reset to the squash commit
  expect(await sh(w.repo, "git", "show", `main:feature.txt`)).toBe("shipped v2");

  // Card done; sessions killed BEFORE the worktree archive; worktree gone.
  const done = getCard(w.db, c.id)!;
  expect(done.phase).toBe("done");
  expect(w.ptys.all.get(liveAgent)!.killed).toBe(true);
  expect(existsSync(wt.path)).toBe(false);
  expect(wtRows(w.db).find((x) => x.id === wt.id)!.state).toBe("archived");

  // Merge is a recorded fact in the timeline (Details drawer only).
  const tl = listTimeline(w.db, c.id);
  expect(tl.some((r) => r.kind === "merge" && r.text.includes(wt.branch))).toBe(true);

  // R4: other review cards re-emitted for the UI to re-check.
  const after = w.events.slice(evBefore);
  expect(after.some((e) => e.t === "card" && e.card.id === other.id)).toBe(true);
}, 20_000);

test("merge on a non-ready card is IllegalTransition (409 path)", async () => {
  const w = await makeWorld();
  const c = card(w, "not ready");
  await toRunning(w, c);
  expect(w.engine.merge(c.id)).rejects.toThrow(IllegalTransition);
});

test("real squash conflict resets main worktree/index and leaves card review.ready", async () => {
  const w = await makeWorld();
  const c = card(w, "Conflict fixture");
  const dispatch = await toRunning(w, c);
  const wt = wtRows(w.db).find((x) => x.id === getCard(w.db, c.id)!.worktreeId)!;

  // Both branches replace the same original line: this is a genuine content
  // conflict, not a preflight refusal.
  await Bun.write(join(wt.path, "a.txt"), "task branch line\n");
  await sh(wt.path, "git", "add", "a.txt");
  await sh(wt.path, "git", "commit", "-m", "task side");
  await Bun.write(join(w.repo, "a.txt"), "main branch line\n");
  await sh(w.repo, "git", "add", "a.txt");
  await sh(w.repo, "git", "commit", "-m", "main side");
  const beforeHead = await sh(w.repo, "git", "rev-parse", "HEAD");

  w.engine.completeFromApi(dispatch);
  await expect(w.engine.merge(c.id)).rejects.toThrow();

  const after = getCard(w.db, c.id)!;
  expect(after.phase).toBe("review");
  expect(after.reviewSub).toBe("ready");
  expect(await sh(w.repo, "git", "rev-parse", "HEAD")).toBe(beforeHead);
  expect(await sh(w.repo, "git", "status", "--porcelain")).toBe("");
  expect(await sh(w.repo, "git", "diff", "--cached", "--name-only")).toBe("");
  expect(await Bun.file(join(w.repo, "a.txt")).text()).toBe("main branch line\n");
  expect(existsSync(join(w.repo, ".git", "MERGE_HEAD"))).toBe(false);
  expect(existsSync(join(w.repo, ".git", "SQUASH_MSG"))).toBe(false);
  expect(wtRows(w.db).find((row) => row.id === wt.id)!.state).toBe("active");
  expect(existsSync(wt.path)).toBe(true);
}, 20_000);

test("per-card action mutex rejects concurrent merge + cancel and keeps repo/card consistent", async () => {
  const w = await makeWorld();
  const c = card(w, "Mutex merge");
  const dispatch = await toRunning(w, c);
  const wt = wtRows(w.db).find((x) => x.id === getCard(w.db, c.id)!.worktreeId)!;
  await Bun.write(join(wt.path, "mutex.txt"), "merged once\n");
  await sh(wt.path, "git", "add", "mutex.txt");
  await sh(wt.path, "git", "commit", "-m", "mutex fixture");
  w.engine.completeFromApi(dispatch);

  // merge() acquires the card lock before its first git await. cancel() runs
  // in the same turn, so this deterministically hits the disclosed async-zone
  // race without timing sleeps.
  const merging = w.engine.merge(c.id);
  let loser: unknown;
  try {
    await w.engine.cancel(c.id);
  } catch (error) {
    loser = error;
  }
  expect(loser).toBeInstanceOf(ActionInProgress);
  expect(loser).toBeInstanceOf(IllegalTransition); // existing HTTP mapper => 409
  expect((loser as Error).message).toBe("action in progress");
  await merging;

  expect(getCard(w.db, c.id)!.phase).toBe("done");
  expect(await sh(w.repo, "git", "show", "main:mutex.txt")).toBe("merged once");
  expect(await sh(w.repo, "git", "status", "--porcelain")).toBe("");
  expect(wtRows(w.db).find((row) => row.id === wt.id)!.state).toBe("archived");
  expect(existsSync(wt.path)).toBe(false);
}, 20_000);

// ---------------------------------------------------------------------------
// Send back — live session injection vs dead-session resume
// ---------------------------------------------------------------------------

test("sendBack with a LIVE session injects into it (Ctrl+U framing) and aliases the session key to a fresh dispatch", async () => {
  const w = await makeWorld();
  const c = card(w, "round trip");
  const d1 = await toRunning(w, c);
  w.engine.completeFromApi(d1);
  await w.engine.idle();

  const sess = w.ptys.all.get(agentSessionId(w, c.id))!;
  const writesBefore = sess.writes.length;
  await w.engine.sendBack(c.id, ["fix the tests", "typo in README"]);

  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("working");
  expect(cur.workingSub).toBe("running");
  expect(cur.round).toBe(2);
  expect(w.adapter.spawns.length).toBe(1); // SAME session — no respawn

  const injected = sess.writes.slice(writesBefore);
  expect(injected.length).toBe(2); // one framed paste + one separate submit
  expect(injected[0]!.startsWith("\x15")).toBe(true); // Ctrl+U clears a restored composer
  expect(injected[0]!).toContain("fix the tests");
  expect(injected[0]!).toContain("typo in README");
  expect(injected[0]!).not.toContain("\r");
  expect(injected[1]!).toBe("\r");

  // Round 2 runs on a NEW dispatch, reachable through the ORIGINAL session key.
  const d2 = dispatchOf(w.db, c.id);
  expect(d2.id).not.toBe(d1);
  expect(d2.status).toBe("running");
  markPendingComplete(w.db, d2.id);
  w.engine.handleSignal(d1, { s: "complete-eval" }); // hooks still arrive under the spawn-time key
  expect(getCard(w.db, c.id)!.phase).toBe("review");
  expect(dispatchOf(w.db, c.id).status).toBe("done");

  // Round history recorded.
  expect(listTimeline(w.db, c.id).some((r) => r.kind === "round" && r.text.includes("fix the tests"))).toBe(true);
});

test("sendBack with a DEAD session spawns a new dispatch with resume + the comments in the prompt", async () => {
  const w = await makeWorld();
  const c = card(w, "resume me");
  const d1 = await toRunning(w, c);
  w.engine.completeFromApi(d1);
  await w.engine.idle();

  w.ptys.die(agentSessionId(w, c.id)); // session gone (daemon kept running)
  await w.engine.sendBack(c.id, ["needs dark mode"]);

  const cur = getCard(w.db, c.id)!;
  expect(cur.round).toBe(2);
  expect(cur.workingSub).toBe("running");
  expect(w.adapter.spawns.length).toBe(2);
  const ctx = w.adapter.spawns[1]!;
  expect(ctx.resumeSessionId).toBe(`asid-${c.id}`); // native resume with the captured id
  expect(ctx.extraPrompt ?? "").toContain("needs dark mode");
  expect(ctx.dispatch.id).not.toBe(d1);
  expect(ctx.attempt.id).toBe(getCard(w.db, c.id)!.attemptId!); // same attempt, same worktree
});

test("dead-session sendBack spawn failure refills the slot without an explicit tick", async () => {
  const w = await makeWorld();
  const a = card(w, "A respawn fails");
  const dispatch = await toRunning(w, a);
  w.engine.completeFromApi(dispatch);
  await w.engine.idle();
  w.ptys.die(agentSessionId(w, a.id));
  const b = card(w, "B follows");
  expect(getCard(w.db, b.id)!.phase).toBe("queued");

  const spawn = w.adapter.spawn.bind(w.adapter);
  let rejectNext = true;
  w.adapter.spawn = async (ctx) => {
    if (!rejectNext) return spawn(ctx);
    rejectNext = false;
    w.adapter.behavior = "reject";
    try {
      return await spawn(ctx);
    } finally {
      w.adapter.behavior = "ok";
    }
  };

  await w.engine.sendBack(a.id, ["try again"]); // no engine.tick() follows
  await w.engine.idle();

  expect(getCard(w.db, a.id)!.workingSub).toBe("error");
  expect(getCard(w.db, b.id)!.phase).toBe("working");
  expect(getCard(w.db, b.id)!.workingSub).toBe("starting");
  expect(w.adapter.spawns.at(-1)!.card.id).toBe(b.id);
});

// ---------------------------------------------------------------------------
// Stop / requeue / cancel
// ---------------------------------------------------------------------------

test("stop writes \\x03 to the live session, parks the card in working.stopped, closes the dispatch", async () => {
  const w = await makeWorld();
  const c = card(w, "stoppable");
  const d = await toRunning(w, c);
  const sess = w.ptys.all.get(agentSessionId(w, c.id))!;

  w.engine.stop(c.id);
  expect(sess.writes[sess.writes.length - 1]).toBe("\x03"); // SIGINT to the fg group
  const cur = getCard(w.db, c.id)!;
  expect(cur.workingSub).toBe("stopped");
  expect(dispatchOf(w.db, c.id).status).toBe("interrupted");

  // Late hooks from the parked session are dropped by the status guard.
  const snap = getCard(w.db, c.id)!;
  w.engine.handleSignal(d, { s: "flag", kind: "question" });
  expect(getCard(w.db, c.id)!).toEqual(snap);

  // stop on a non-running card → IllegalTransition.
  expect(() => w.engine.stop(c.id)).toThrow(IllegalTransition);
});

test("resume continues an explicitly stopped card on the same attempt and worktree", async () => {
  const w = await makeWorld();
  const c = card(w, "pause and resume");
  await toRunning(w, c);
  const before = getCard(w.db, c.id)!;

  w.engine.stop(c.id);
  await w.engine.resume(c.id);

  const cur = getCard(w.db, c.id)!;
  const ctx = w.adapter.spawns.at(-1)!;
  expect(cur.workingSub).toBe("starting");
  expect(cur.attemptId).toBe(before.attemptId);
  expect(cur.worktreeId).toBe(before.worktreeId);
  expect(ctx.attempt.id).toBe(before.attemptId!);
  expect(ctx.worktreePath).toBe(wtRows(w.db)[0]!.path);
  expect(dispatchOf(w.db, c.id).status).toBe("running");
});

test("B3: stop-resume dispatch boundary clears manual override before new detection signals", async () => {
  const w = await makeWorld();
  const c = card(w, "override then resume");
  await toRunning(w, c);
  await w.engine.markState(c.id, "running");
  w.engine.stop(c.id);
  await w.engine.resume(c.id);

  const resumed = dispatchOf(w.db, c.id);
  w.engine.handleSignal(resumed.id, {
    s: "session-started",
    adapterSessionId: "resumed-session",
  });
  w.engine.handleSignal(resumed.id, { s: "flag", kind: "permission" });
  expect(getCard(w.db, c.id)!.inputKind).toBe("permission");

  w.engine.handleSignal(resumed.id, { s: "flag-clear" });
  expect(getCard(w.db, c.id)!.inputKind).toBeNull();
});

test("stop refills the freed slot: workerLimit 1, A running + B queued auto:on → stop(A) starts B with no explicit tick", async () => {
  const w = await makeWorld(); // workerLimit defaults to 1
  const a = card(w, "A holds the slot");
  const b = card(w, "B waits behind it");
  await toRunning(w, a);
  expect(getCard(w.db, b.id)!.phase).toBe("queued"); // slot full — B held back

  w.engine.stop(a.id); // no engine.tick() call anywhere after this
  await w.engine.idle();

  const cur = getCard(w.db, b.id)!;
  expect(cur.phase).toBe("working");
  expect(["starting", "running"]).toContain(cur.workingSub!);
  expect(w.adapter.spawns.length).toBe(2);
  expect(w.adapter.spawns[1]!.card.id).toBe(b.id);
  expect(getCard(w.db, a.id)!.workingSub).toBe("stopped"); // A stays parked
});

test("requeue keeps + pins the worktree; a later start reuses it instead of creating a new one", async () => {
  const w = await makeWorld();
  const c = card(w, "come back");
  await toRunning(w, c);
  w.engine.stop(c.id);

  const wtId = getCard(w.db, c.id)!.worktreeId!;
  w.engine.requeue(c.id);
  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("queued");
  expect(cur.auto).toBe(false); // requeue-auto-off
  expect(cur.worktreeId).toBe(wtId); // pin: pointer retained…
  expect(wtRows(w.db).find((x) => x.id === wtId)!.state).toBe("active"); // …worktree stays active

  await w.engine.start(c.id); // manual start (auto is off)
  expect(getCard(w.db, c.id)!.worktreeId).toBe(wtId); // reused, not recreated
  expect(wtRows(w.db).length).toBe(1);
  expect(attemptRows(w.db, c.id).length).toBe(2); // fresh attempt on the same worktree
  expect(attemptRows(w.db, c.id)[0]!.status).toBe("discarded"); // superseded, not failed (breaker-neutral)
});

test("start after stop→requeue kills the PARKED agent CLI before the fresh spawn (no double-run)", async () => {
  const w = await makeWorld();
  const c = card(w, "parked CLI");
  await toRunning(w, c);
  const parked = w.ptys.all.get(agentSessionId(w, c.id))!;

  w.engine.stop(c.id); // \x03 only interrupts the turn — the CLI itself stays alive
  await w.engine.idle();
  expect(parked.killed).toBe(false); // parked, not dead
  w.engine.requeue(c.id);

  await w.engine.start(c.id);
  expect(parked.killed).toBe(true); // killTrackedAgent ran before the new spawn
  expect(w.adapter.spawns.length).toBe(2); // …and the fresh spawn still happened
  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("working");
  // The parked session's exit evaluation dropped at the terminal-dispatch
  // guard — the fresh dispatch is untouched by the old session's death.
  await w.engine.idle();
  expect(dispatchOf(w.db, c.id).status).toBe("running");
});

test("late session-started (codex lazy TUI firing): flags before it are dropped without throwing", async () => {
  const w = await makeWorld();
  const c = card(w, "lazy codex");
  await w.engine.start(c.id); // working.starting — SessionStart not yet fired
  const d = dispatchOf(w.db, c.id);

  // The fail-open transport may deliver hooks before session-started; codex
  // TUIs additionally fire session hooks lazily at first submit. These must
  // be dropped (I2: never false progress), never thrown.
  expect(() => w.engine.handleSignal(d.id, { s: "flag", kind: "permission" })).not.toThrow();
  expect(() => w.engine.handleSignal(d.id, { s: "complete-eval" })).not.toThrow();
  let cur = getCard(w.db, c.id)!;
  expect(cur.workingSub).toBe("starting");
  expect(cur.inputKind).toBeNull();

  // The LATE session-started still lands and the card runs normally after.
  w.engine.handleSignal(d.id, { s: "session-started", adapterSessionId: "asid-late" });
  expect(getCard(w.db, c.id)!.workingSub).toBe("running");
  w.engine.handleSignal(d.id, { s: "flag", kind: "question" });
  cur = getCard(w.db, c.id)!;
  expect(cur.inputKind).toBe("question");
});

test("cancel kills sessions and archives the worktree (I3: archiving kills sessions)", async () => {
  const w = await makeWorld();
  const c = card(w, "abort");
  await toRunning(w, c);
  const sess = w.ptys.all.get(agentSessionId(w, c.id))!;
  const wtId = getCard(w.db, c.id)!.worktreeId!;

  await w.engine.cancel(c.id);
  const cur = getCard(w.db, c.id)!;
  expect(cur.phase).toBe("cancelled");
  expect(sess.killed).toBe(true); // killed BEFORE archive — the effect interpreter's contract
  expect(wtRows(w.db).find((x) => x.id === wtId)!.state).toBe("archived");
  const branches = await sh(w.repo, "git", "branch", "--list", `cg/${c.id}-*`);
  expect(branches).not.toBe(""); // branch kept (14-day policy) — only the dir is gone
});

test("cancel refills a workerLimit 1 slot without an explicit tick", async () => {
  const w = await makeWorld();
  const a = card(w, "A is cancelled");
  const b = card(w, "B follows");
  await toRunning(w, a);
  expect(getCard(w.db, b.id)!.phase).toBe("queued");

  await w.engine.cancel(a.id); // no engine.tick() follows
  await w.engine.idle();

  expect(getCard(w.db, a.id)!.phase).toBe("cancelled");
  expect(getCard(w.db, b.id)!.phase).toBe("working");
  expect(getCard(w.db, b.id)!.workingSub).toBe("starting");
  expect(w.adapter.spawns.at(-1)!.card.id).toBe(b.id);
});

test("delete cleans a queued pinned worktree and its sessions before removing lifecycle rows", async () => {
  const w = await makeWorld();
  const c = card(w, "delete pinned");
  await toRunning(w, c);
  const agentId = agentSessionId(w, c.id);
  const wt = wtRows(w.db)[0]!;
  const shell = w.ptys.open({
    projectId: w.project.id,
    cwd: wt.path,
    title: "task shell",
    worktreeId: wt.id,
  });
  appendTimeline(w.db, c.id, "progress", "will be removed");
  w.engine.stop(c.id);
  w.engine.requeue(c.id);
  expect(getCard(w.db, c.id)!.phase).toBe("queued");
  expect(getCard(w.db, c.id)!.worktreeId).toBe(wt.id);

  await w.engine.delete(c.id);

  expect(w.ptys.all.get(agentId)!.killed).toBe(true);
  expect(w.ptys.all.get(shell.id)!.killed).toBe(true);
  expect(existsSync(wt.path)).toBe(false);
  expect(wtRows(w.db).find(row => row.id === wt.id)!.state).toBe("archived");
  expect(getCard(w.db, c.id)).toBeNull();
  expect((w.db.query(`SELECT COUNT(*) AS n FROM attempts WHERE card_id = ?1`).get(c.id) as any).n).toBe(0);
  expect((w.db.query(`SELECT COUNT(*) AS n FROM dispatches WHERE attempt_id NOT IN (SELECT id FROM attempts)`).get() as any).n).toBe(0);
  expect((w.db.query(`SELECT COUNT(*) AS n FROM sessions WHERE attempt_id IS NOT NULL OR worktree_id = ?1`).get(wt.id) as any).n).toBe(0);
  expect((w.db.query(`SELECT COUNT(*) AS n FROM timeline WHERE card_id = ?1`).get(c.id) as any).n).toBe(0);
  expect(w.events.some(event => event.t === "cardDeleted" && event.id === c.id)).toBe(true);
}, 15_000);

// ---------------------------------------------------------------------------
// Part 3 — stale cascade, update flow, conflict observation, merge modes
// ---------------------------------------------------------------------------

/** Drive a card to review.ready with one real commit writing `file`→`content`. */
async function reviewReadyCard(w: World, title: string, file: string, content: string): Promise<{ c: Card; wt: ReturnType<typeof wtRows>[number] }> {
  const c = card(w, title, { auto: false });
  const d = await toRunning(w, c);
  const wt = wtRows(w.db).find((x) => x.id === getCard(w.db, c.id)!.worktreeId)!;
  await Bun.write(join(wt.path, file), content);
  await sh(wt.path, "git", "add", "-A");
  await sh(wt.path, "git", "commit", "-m", `${title} work`);
  w.engine.completeFromApi(d);
  await w.engine.idle();
  expect(getCard(w.db, c.id)!.reviewSub).toBe("ready");
  return { c, wt };
}

const wtRow = (w: World, id: string) =>
  w.db.query(`SELECT sync, behind_count FROM worktrees WHERE id = ?1`).get(id) as { sync: string; behind_count: number };

test("merge cascade marks behind siblings stale; update rebases back to ready and invalidates only base-delta viewed marks", async () => {
  const w = await makeWorld();
  const a = await reviewReadyCard(w, "Alpha", "shared.txt", "from alpha\n");
  const b = await reviewReadyCard(w, "Beta", "beta.txt", "beta own file\n");

  // Beta reviewed both a base-delta file and its own file before the cascade.
  setReviewed(w.db, b.c.id, "shared.txt", true);
  setReviewed(w.db, b.c.id, "beta.txt", true);

  await w.engine.merge(a.c.id); // squash default
  const stale = getCard(w.db, b.c.id)!;
  expect(stale.reviewSub).toBe("stale");
  expect(wtRow(w, b.wt.id)).toEqual({ sync: "behind", behind_count: 1 });

  // Merge is blocked while stale (guard is the machine's reviewReady).
  await expect(w.engine.merge(b.c.id)).rejects.toThrow(IllegalTransition);

  await w.engine.update(b.c.id);
  const updated = getCard(w.db, b.c.id)!;
  expect(updated.reviewSub).toBe("ready");
  expect(wtRow(w, b.wt.id)).toEqual({ sync: "clean", behind_count: 0 });
  // shared.txt came in via the base delta → its viewed-mark died; beta.txt survived.
  expect(listReviewedFiles(w.db, b.c.id)).toEqual(["beta.txt"]);
  // The rebased worktree actually contains Alpha's merged content.
  expect(await sh(b.wt.path, "git", "show", "HEAD:shared.txt")).toBe("from alpha");

  await w.engine.merge(b.c.id); // stale → updated → mergeable again
  expect(getCard(w.db, b.c.id)!.phase).toBe("done");
}, 25_000);

test("update conflict leaves the rebase for the terminal; resolve + continue → poll lands ready", async () => {
  const w = await makeWorld();
  const a = await reviewReadyCard(w, "Alpha", "clash.txt", "alpha version\n");
  const b = await reviewReadyCard(w, "Beta", "clash.txt", "beta version\n");
  await w.engine.merge(a.c.id);
  expect(getCard(w.db, b.c.id)!.reviewSub).toBe("stale");

  await w.engine.update(b.c.id); // rebase conflicts on clash.txt
  expect(getCard(w.db, b.c.id)!.reviewSub).toBe("conflict");
  expect(wtRow(w, b.wt.id).sync).toBe("conflicted");
  // The rebase is genuinely in progress inside the worktree (never auto-aborted).
  const gitDir = await sh(b.wt.path, "git", "rev-parse", "--absolute-git-dir");
  expect(existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))).toBe(true);

  // Poll while unresolved: still conflict.
  await w.engine.pollConflicts();
  expect(getCard(w.db, b.c.id)!.reviewSub).toBe("conflict");

  // User resolves in the worktree terminal.
  await Bun.write(join(b.wt.path, "clash.txt"), "merged by hand\n");
  await sh(b.wt.path, "git", "add", "-A");
  await sh(b.wt.path, "git", "-c", "core.editor=true", "rebase", "--continue");

  await w.engine.pollConflicts();
  const done = getCard(w.db, b.c.id)!;
  expect(done.reviewSub).toBe("ready");
  expect(wtRow(w, b.wt.id)).toEqual({ sync: "clean", behind_count: 0 });
}, 25_000);

test("aborting the conflicted rebase degrades to stale, not ready-with-lies", async () => {
  const w = await makeWorld();
  const a = await reviewReadyCard(w, "Alpha", "clash.txt", "alpha version\n");
  const b = await reviewReadyCard(w, "Beta", "clash.txt", "beta version\n");
  await w.engine.merge(a.c.id);
  await w.engine.update(b.c.id);
  expect(getCard(w.db, b.c.id)!.reviewSub).toBe("conflict");

  await sh(b.wt.path, "git", "rebase", "--abort");
  await w.engine.pollConflicts();
  const backToStale = getCard(w.db, b.c.id)!;
  expect(backToStale.reviewSub).toBe("stale"); // still behind — resolved nothing
  expect(wtRow(w, b.wt.id)).toEqual({ sync: "behind", behind_count: 1 });
}, 25_000);

test("merge mode 'merge' produces a two-parent commit; 'rebase' stays linear; both zero the branch", async () => {
  const w1 = await makeWorld();
  const m = await reviewReadyCard(w1, "TrueMerge", "m.txt", "m\n");
  await w1.engine.merge(m.c.id, "merge");
  const parents = (await sh(w1.repo, "git", "rev-list", "--parents", "-n", "1", "main")).split(" ");
  expect(parents.length).toBe(3); // sha + 2 parents = merge commit
  expect(await sh(w1.repo, "git", "rev-parse", m.wt.branch)).toBe(await sh(w1.repo, "git", "rev-parse", "main"));

  const w2 = await makeWorld();
  const r = await reviewReadyCard(w2, "Rebased", "r.txt", "r\n");
  await w2.engine.merge(r.c.id, "rebase");
  const rp = (await sh(w2.repo, "git", "rev-list", "--parents", "-n", "1", "main")).split(" ");
  expect(rp.length).toBe(2); // linear — no merge commit
  expect(await sh(w2.repo, "git", "log", "--format=%s", "-n", "1", "main")).toBe("Rebased work");
  expect(await sh(w2.repo, "git", "rev-parse", r.wt.branch)).toBe(await sh(w2.repo, "git", "rev-parse", "main"));
}, 25_000);

test("update on a non-stale card is IllegalTransition (409 path)", async () => {
  const w = await makeWorld();
  const { c } = await reviewReadyCard(w, "NotStale", "x.txt", "x\n");
  await expect(w.engine.update(c.id)).rejects.toThrow(IllegalTransition);
});

// ---------------------------------------------------------------------------
// Part 3 — PR tracking (scripted gh runner)
// ---------------------------------------------------------------------------

/** gh runner whose `pr view` answer is swappable mid-test. */
function ghStub(): { runner: EngineDeps["prRunner"]; setView: (v: object) => void; calls: string[][] } {
  let view: object = {};
  const calls: string[][] = [];
  return {
    setView: (v) => (view = v),
    calls,
    runner: async (_cwd, cmd) => {
      calls.push(cmd);
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") {
        return { code: 0, stdout: JSON.stringify(view), stderr: "" };
      }
      if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "create") {
        return { code: 0, stdout: "https://github.com/x/y/pull/9\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" }; // gh --version, git remote, gh auth, git push, git log
    },
  };
}

test("prCreate persists PR facts; poll open→merged records the fact once, archives, cascades", async () => {
  const gh = ghStub();
  const w = await makeWorld({ prRunner: gh.runner });
  const a = await reviewReadyCard(w, "PrAlpha", "pa.txt", "pa\n");
  const b = await reviewReadyCard(w, "PrBeta", "pb.txt", "pb\n");

  gh.setView({ number: 9, url: "https://github.com/x/y/pull/9", state: "OPEN",
    statusCheckRollup: [{ status: "IN_PROGRESS" }] });
  await w.engine.prCreate(a.c.id);
  let card = getCard(w.db, a.c.id)!;
  expect(card.prNumber).toBe(9);
  expect(card.prUrl).toContain("/pull/9");
  expect(card.prState).toBe("open");
  expect(card.ciStatus).toBe("pending");
  // The templated description flowed through gh pr create with title/base/head.
  const create = gh.calls.find((c) => c[1] === "pr" && c[2] === "create")!;
  expect(create).toContain("PrAlpha");
  expect(create).toContain(a.wt.branch);

  // CI flips to pass → event-only update.
  gh.setView({ number: 9, url: "https://github.com/x/y/pull/9", state: "OPEN",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
  await w.engine.pollPrs();
  expect(getCard(w.db, a.c.id)!.ciStatus).toBe("pass");
  expect(getCard(w.db, a.c.id)!.phase).toBe("review");

  // Externally merged → recorded fact: done, archived, sibling cascade.
  gh.setView({ number: 9, url: "https://github.com/x/y/pull/9", state: "MERGED", statusCheckRollup: [] });
  await w.engine.pollPrs();
  card = getCard(w.db, a.c.id)!;
  expect(card.phase).toBe("done");
  expect(card.prState).toBe("merged");
  expect(wtRows(w.db).find((x) => x.id === a.wt.id)!.state).toBe("archived");
  const tl = listTimeline(w.db, a.c.id);
  expect(tl.some((r) => r.kind === "merge" && r.text.includes("#9"))).toBe(true);
  // One-shot: a second poll with no open PRs is a no-op (and clears itself).
  await w.engine.pollPrs();
  expect(getCard(w.db, a.c.id)!.phase).toBe("done");
  // NOTE: external merge does not move the LOCAL base, so the sibling stays
  // ready (cascade measured behind=0) — asserted to lock the semantics.
  expect(getCard(w.db, b.c.id)!.reviewSub).toBe("ready");
}, 25_000);

test("closed PR keeps the card in review; prCreate is illegal off-review; manual mark-merged needs no gh", async () => {
  const gh = ghStub();
  const w = await makeWorld({ prRunner: gh.runner });
  const a = await reviewReadyCard(w, "PrClosed", "pc.txt", "pc\n");
  gh.setView({ number: 3, url: "u3", state: "OPEN", statusCheckRollup: [] });
  await w.engine.prCreate(a.c.id);
  gh.setView({ number: 3, url: "u3", state: "CLOSED", statusCheckRollup: [] });
  await w.engine.pollPrs();
  const closed = getCard(w.db, a.c.id)!;
  expect(closed.phase).toBe("review"); // closed ≠ merged — still reviewable/mergeable locally
  expect(closed.prState).toBe("closed");

  const queued = card(w, "NoPr", { auto: false });
  await expect(w.engine.prCreate(queued.id)).rejects.toThrow(IllegalTransition);

  // Manual fallback (no gh at all): plain world, recorded fact straight to done.
  const w2 = await makeWorld();
  const m = await reviewReadyCard(w2, "Manual", "mm.txt", "mm\n");
  await w2.engine.markPrMerged(m.c.id);
  const done = getCard(w2.db, m.c.id)!;
  expect(done.phase).toBe("done");
  expect(wtRows(w2.db).find((x) => x.id === m.wt.id)!.state).toBe("archived");
  expect(listTimeline(w2.db, m.c.id).some((r) => r.text.includes("marked merged"))).toBe(true);
}, 25_000);
