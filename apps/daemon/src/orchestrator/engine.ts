import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Attempt, Card, Dispatch, DomainEvent, Project, Worktree } from "@codegent/protocol";
import { transition, IllegalTransition, type Effect, type MachineEvent } from "./machine";
import { getCard, updateCard } from "../store/cards";
import { getProject, listProjects } from "../store/projects";
import {
  completeDispatch, createAttempt, createDispatch, pendingComplete,
  setAttemptStatus, setAttemptWorktree, supersedeRunningAttempts,
} from "../store/attempts";
import { setAdapterSessionId } from "../store/sessions";
import { appendTimeline } from "../store/timeline";
import { archiveWorktree, createWorktree } from "../git/worktrees";
import { reapProcessGroup } from "../pty/reap";
import type { AdapterSignal, AgentAdapter, SpawnResult } from "../agents/types";
import type { PtyManager } from "../pty/manager";

/**
 * The orchestrator engine (spec §5) — R1 queue→start, R2 input→Waiting,
 * R3 completion→Review, R4 merge→archive+cascade+R1, plus the §6.1 dispatch
 * envelope (attempt + write-once dispatch latch), heartbeat/runaway notices,
 * and the 3-strike circuit breaker.
 *
 * Division of authority: `transition()` (T3) is the ONLY judge of card-state
 * legality. On EXTERNAL inputs (HTTP action routes) an IllegalTransition
 * propagates for the route to map to 409; on INTERNAL signal paths it is a
 * bug-or-staleness symptom — logged and dropped, never thrown.
 *
 * Effect interpretation (per-effect contract, review obligations included):
 * - `create-worktree`/`spawn-agent` — the start/launch pipeline below.
 * - `archive-worktree` — ALWAYS kill-sessions-then-archive (§4.2 I3
 *   "archiving kills sessions"); `merged`'s explicit `kill-sessions` +
 *   `archive-worktree` pair dedupes into that same single sequence
 *   (terminate() is idempotent, dead sessions drop out of the live map).
 *   Exception: `start-failed` interprets it as PARTIAL ROLLBACK — the
 *   worktree/branch/row created by THIS start are deleted outright (a
 *   just-created branch has no history worth 14-day retention, and retries
 *   would collide on the branch name); a PRE-EXISTING worktree (requeue's
 *   pin) is never rolled back or archived by a failed restart.
 * - `requeue-auto-off` — fully expressed by the machine's persisted
 *   `auto:false`; the worktree row deliberately stays active and
 *   `card.worktreeId` is retained: that retained pointer IS the v0.2 pin,
 *   honored by `ensureWorktree`'s reuse path.
 * - `compute-diffstat` — no-op in v0.2 (the diff view computes on demand;
 *   the effect slot is v0.3's cache hook).
 * - `push` — no-op hook until §11 notifications land.
 * - `undo-toast` — T9 (discard flow).
 *
 * Session-key routing: hook + MCP identity is the SPAWN-TIME dispatch id
 * (T7 bakes CODEGENT_SESSION_ID=<dispatchId> into the hook command and the
 * sidecar env). A live-session send-back opens a NEW dispatch without
 * respawning, so `routes` aliases spawn-key → current live dispatch; losing
 * the map on daemon restart is fine — PTYs die with the daemon, so the alias
 * is exactly as durable as the session it serves.
 */

export class CardNotFound extends Error {
  constructor(id: number | string) {
    super(`card ${id} not found`);
    this.name = "CardNotFound";
  }
}

/** `none` cards and agents with no registered adapter cannot be started (409 at the API). */
export class NotStartable extends Error {
  constructor(agent: string) {
    super(`agent '${agent}' is not startable`);
    this.name = "NotStartable";
  }
}

/** The slice of a live PTY session the engine consumes (PtyManager satisfies it). */
export interface EnginePtySession {
  write(data: Uint8Array | string): void;
  terminate(): Promise<number>;
  readonly exited: Promise<number>;
  readonly pid: number;
}
export interface EnginePtys {
  get(id: string): EnginePtySession | undefined;
}
// Compile-time proof the real manager satisfies the engine's structural slice.
const _ptyManagerIsEnginePtys = (m: PtyManager): EnginePtys => m;
void _ptyManagerIsEnginePtys;

export type AdapterRegistry = { claude: AgentAdapter | null; codex: AgentAdapter | null };

export interface EngineTimers {
  /** Progress-silence soft warning (spec §5: >10 min, never auto-fail). */
  heartbeatWarnMs: number;
  /** Runaway guard (spec §5: card running >30 min). */
  runawayMs: number;
  /** Adapter spawn budget (VK-proven 30 s). */
  spawnTimeoutMs: number;
  /** Paste→Enter settle for engine-side injection (send-back comments). */
  injectSettleMs: number;
}
const DEFAULT_TIMERS: EngineTimers = {
  heartbeatWarnMs: 10 * 60_000,
  runawayMs: 30 * 60_000,
  spawnTimeoutMs: 30_000,
  injectSettleMs: 500,
};

/** v0.2 runs every dispatch in the agent's native sandbox (spec §6 "sandboxed
 * by default"); per-card mode selection + persistence arrive with T9. */
const V02_MODE = "auto" as const;
const BREAKER_LIMIT = 3;

export interface EngineDeps {
  db: Database;
  ptys: EnginePtys;
  adapters: AdapterRegistry;
  events: { emit(e: DomainEvent): void };
  clock: () => number;
  timers?: Partial<EngineTimers>;
}

interface DispatchEnvelope {
  id: string;
  status: Dispatch["status"];
  attemptId: number;
  cardId: number;
}

const sanitizeInjection = (s: string): string =>
  s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited, new Response(p.stdout).text(), new Response(p.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err.trim() || `git ${args[0]} failed (${code})`);
  return out;
}
async function gitCode(cwd: string, ...args: string[]): Promise<number> {
  const p = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return p.exited;
}

export class Engine {
  private timers: EngineTimers;
  /** Session-key (spawn-time dispatch id) → current live dispatch id. */
  private routes = new Map<string, string>();
  /** Card → its live agent PTY id / spawn key / captured adapter session id. */
  private ptyByCard = new Map<number, string>();
  private spawnKeyByCard = new Map<number, string>();
  private asidByCard = new Map<number, string>();
  private ptyByDispatch = new Map<string, string>();
  /** Notice dedup: heartbeat warns once per (dispatch, progress-stamp); runaway once per dispatch. */
  private hbWarned = new Map<string, number>();
  private runawayFired = new Set<string>();
  /** In-flight background work (fire-and-forget starts) — awaited by tests via idle(). */
  private inflight = new Set<Promise<unknown>>();

  constructor(private deps: EngineDeps) {
    this.timers = { ...DEFAULT_TIMERS, ...deps.timers };
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private track(p: Promise<unknown>): void {
    const wrapped = p.catch((e) => console.warn("[engine] background task failed:", e));
    this.inflight.add(wrapped);
    void wrapped.finally(() => this.inflight.delete(wrapped));
  }

  /** Test/shutdown helper: resolves once all background work has settled. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  /** Persist a machine-produced card and fan it out as a domain event. */
  private persist(card: Card, extra: Partial<Pick<Card, "worktreeId" | "attemptId">> = {}): Card {
    const saved = updateCard(this.deps.db, card.id, {
      phase: card.phase, workingSub: card.workingSub, errorKind: card.errorKind,
      reviewSub: card.reviewSub, inputKind: card.inputKind, inputSince: card.inputSince,
      round: card.round, auto: card.auto,
      worktreeId: card.worktreeId, attemptId: card.attemptId,
      ...extra,
    });
    this.deps.events.emit({ t: "card", card: saved });
    return saved;
  }

  /** Internal-signal transition: IllegalTransition here means a stale or
   * buggy signal — log it (it's a bug if it recurs), never throw. */
  private driveInternal(card: Card, ev: MachineEvent): { card: Card; effects: Effect[] } | null {
    try {
      return transition(card, ev, this.deps.clock());
    } catch (e) {
      if (e instanceof IllegalTransition) {
        console.warn(`[engine] dropped illegal internal transition on card ${card.id}: ${e.message}`);
        return null;
      }
      throw e;
    }
  }

  private adapterFor(agent: Card["agent"]): AgentAdapter {
    const a = agent === "none" ? null : this.deps.adapters[agent];
    if (!a) throw new NotStartable(agent);
    return a;
  }

  /** Public for the agent-plane routes (mcp.ts): spawn-key → live dispatch id. */
  resolveAgentDispatch(id: string): string {
    return this.routes.get(id) ?? id;
  }

  private envelope(dispatchId: string): DispatchEnvelope | null {
    const r = this.deps.db.query(
      `SELECT d.id AS id, d.status AS status, d.attempt_id AS attempt_id, a.card_id AS card_id
       FROM dispatches d JOIN attempts a ON a.id = d.attempt_id WHERE d.id = ?1`,
    ).get(dispatchId) as any;
    return r ? { id: r.id, status: r.status, attemptId: r.attempt_id, cardId: r.card_id } : null;
  }

  private worktreeRow(id: string): Worktree | null {
    const r = this.deps.db.query(`SELECT * FROM worktrees WHERE id = ?1`).get(id) as any;
    return r
      ? { id: r.id, projectId: r.project_id, branch: r.branch, path: r.path, base: r.base, state: r.state }
      : null;
  }

  // -------------------------------------------------------------------------
  // R1 — queue → start
  // -------------------------------------------------------------------------

  /** While `working(starting|running) < workerLimit`, start the topmost queued
   * auto:on card whose agent has a registered adapter. Stopped/error cards do
   * NOT hold a slot (spec: "free a slot by stopping a running card"). */
  tick(): void {
    const db = this.deps.db;
    const startable = (Object.keys(this.deps.adapters) as Array<keyof AdapterRegistry>)
      .filter((k) => this.deps.adapters[k] !== null);
    if (startable.length === 0) return;
    const marks = startable.map((_, i) => `?${i + 2}`).join(",");
    for (const project of listProjects(db)) {
      for (;;) {
        const active = (db.query(
          `SELECT COUNT(*) AS n FROM cards
           WHERE project_id = ?1 AND phase = 'working' AND working_sub IN ('starting','running')`,
        ).get(project.id) as any).n as number;
        if (active >= project.workerLimit) break;
        const next = db.query(
          `SELECT id FROM cards
           WHERE project_id = ?1 AND phase = 'queued' AND auto = 1 AND agent IN (${marks})
           ORDER BY position LIMIT 1`,
        ).get(project.id, ...startable) as any;
        if (!next) break;
        // start()'s synchronous section flips the card to working.starting
        // before its first await, so the next loop pass counts the slot.
        this.track(this.start(next.id));
        const after = getCard(db, next.id);
        if (!after || after.phase !== "working") break; // sync phase didn't take — never loop on it
      }
    }
  }

  // -------------------------------------------------------------------------
  // start — queued → starting → (spawn) …
  // -------------------------------------------------------------------------

  async start(cardId: number): Promise<void> {
    const card = getCard(this.deps.db, cardId);
    if (!card) throw new CardNotFound(cardId);
    const adapter = this.adapterFor(card.agent); // NotStartable → 409 at the API
    const project = getProject(this.deps.db, card.projectId);
    if (!project) throw new CardNotFound(`project ${card.projectId}`);
    const next = transition(card, { t: "start" }, this.deps.clock()); // IllegalTransition → 409
    // SYNC persist (before any await): R1's slot accounting must see it.
    const starting = this.persist(next.card);
    // Effects [create-worktree, spawn-agent] — the launch pipeline:
    await this.launch(starting, project, adapter);
  }

  private async launch(card: Card, project: Project, adapter: AgentAdapter): Promise<void> {
    const db = this.deps.db;
    // A fresh start supersedes any prior still-running attempt (user-stop →
    // requeue → restart): discarded, not failed — breaker-neutral.
    supersedeRunningAttempts(db, card.id);
    // Attempt BEFORE worktree so every failure mode past this point is a
    // countable attempt for the circuit breaker (worktree binding lands below).
    const attempt = createAttempt(db, { cardId: card.id, worktreeId: null, beforeHead: null });
    const dispatch = createDispatch(db, attempt.id);
    this.routes.set(dispatch.id, dispatch.id);
    let wt: Worktree | undefined;
    let createdNew = false;
    try {
      const r = await this.ensureWorktree(project, card);
      wt = r.wt;
      createdNew = r.created;
      const beforeHead = (await git(wt.path, "rev-parse", "HEAD")).trim();
      setAttemptWorktree(db, attempt.id, wt.id, beforeHead);
      const wired = this.persist({ ...card, worktreeId: wt.id, attemptId: attempt.id });
      this.deps.events.emit({
        t: "attempt",
        attempt: { ...attempt, worktreeId: wt.id, beforeHead } satisfies Attempt,
      });
      const res = await this.spawnWithTimeout(adapter, {
        project, card: wired, attempt: { ...attempt, worktreeId: wt.id, beforeHead },
        dispatch, worktreePath: wt.path,
      });
      this.registerSpawn(card.id, dispatch.id, res);
    } catch (e) {
      await this.startFailed(card.id, attempt.id, dispatch.id, createdNew && wt ? { project, wt } : null, e);
    }
  }

  /** I1-preserving worktree resolution: reuse the card's retained ACTIVE
   * worktree (requeue pin); re-add a missing dir from the kept branch (VK
   * worktrees-as-cattle); else create fresh. */
  private async ensureWorktree(project: Project, card: Card): Promise<{ wt: Worktree; created: boolean }> {
    const db = this.deps.db;
    if (card.worktreeId) {
      const row = this.worktreeRow(card.worktreeId);
      if (row) {
        if (row.state === "active" && existsSync(row.path)) return { wt: row, created: false };
        await git(project.path, "worktree", "prune").catch(() => {});
        await git(project.path, "worktree", "add", row.path, row.branch);
        db.query(`UPDATE worktrees SET state = 'active' WHERE id = ?1`).run(row.id);
        return { wt: { ...row, state: "active" }, created: false };
      }
    }
    return { wt: await createWorktree(db, project, { cardId: card.id, slugSource: card.title }), created: true };
  }

  private spawnWithTimeout(
    adapter: AgentAdapter,
    ctx: Omit<Parameters<AgentAdapter["spawn"]>[0], "mode">,
  ): Promise<SpawnResult> {
    const ms = this.timers.spawnTimeoutMs;
    const p = adapter.spawn({ ...ctx, mode: V02_MODE });
    return new Promise<SpawnResult>((resolve, reject) => {
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        reject(new Error(`adapter spawn timed out after ${ms}ms`));
      }, ms);
      p.then(
        (r) => {
          clearTimeout(t);
          if (!timedOut) return resolve(r);
          // Late arrival after the timeout already failed the start: the
          // session must not linger half-orphaned — kill it.
          void this.deps.ptys.get(r.sessionMeta.id)?.terminate();
        },
        (e) => {
          clearTimeout(t);
          if (!timedOut) reject(e);
        },
      );
    });
  }

  private registerSpawn(cardId: number, dispatchId: string, res: SpawnResult): void {
    this.ptyByCard.set(cardId, res.sessionMeta.id);
    this.ptyByDispatch.set(dispatchId, res.sessionMeta.id);
    this.spawnKeyByCard.set(cardId, dispatchId);
    // Post-exit reaping (§6.1): the PTY child is pgroup leader (pgid == pid);
    // once it exits, SIGKILL whatever HUP-immune children it left behind.
    const sess = this.deps.ptys.get(res.sessionMeta.id);
    if (sess && sess.pid > 0) {
      const pgid = sess.pid;
      void sess.exited.then(() => reapProcessGroup(pgid)).catch(() => {});
    }
  }

  private async startFailed(
    cardId: number,
    attemptId: number,
    dispatchId: string,
    rollback: { project: Project; wt: Worktree } | null,
    cause: unknown,
  ): Promise<void> {
    const db = this.deps.db;
    console.warn(`[engine] start failed for card ${cardId}:`, cause instanceof Error ? cause.message : cause);
    completeDispatch(db, dispatchId, "failed");
    setAttemptStatus(db, attemptId, "failed");
    const cur = getCard(db, cardId);
    if (!cur) return;
    const next = this.driveInternal(cur, { t: "start-failed" });
    if (!next) return;
    // archive-worktree effect, start-failed flavor = partial rollback of what
    // THIS start created; a reused (pinned) worktree is left untouched.
    this.persist(next.card, rollback ? { worktreeId: null } : {});
    if (rollback) await this.rollbackWorktree(rollback.project, rollback.wt);
    this.breakerCheck(cardId);
    this.tick(); // R1 continues — retries this card while auto:on, bounded by the breaker
  }

  private async rollbackWorktree(project: Project, wt: Worktree): Promise<void> {
    const db = this.deps.db;
    await git(project.path, "worktree", "remove", "--force", wt.path).catch(() => {});
    await git(project.path, "branch", "-D", wt.branch).catch(() => {});
    db.query(`DELETE FROM worktrees WHERE id = ?1`).run(wt.id);
  }

  /** 3 consecutive FAILED attempts → force auto:false (card state stays put);
   * R1 skips it, nothing ever auto-restarts into the same failure. */
  private breakerCheck(cardId: number): void {
    const rows = this.deps.db.query(
      `SELECT status FROM attempts WHERE card_id = ?1 ORDER BY seq DESC`,
    ).all(cardId) as Array<{ status: string }>;
    let streak = 0;
    for (const r of rows) {
      if (r.status === "failed") streak++;
      else break;
    }
    if (streak >= BREAKER_LIMIT) {
      const card = getCard(this.deps.db, cardId);
      if (card && card.auto) {
        const saved = updateCard(this.deps.db, cardId, { auto: false });
        this.deps.events.emit({ t: "card", card: saved });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Signals (hook plane) — identity key IS the spawn-time dispatch id
  // -------------------------------------------------------------------------

  handleSignal(dispatchId: string, sig: AdapterSignal): void {
    const db = this.deps.db;
    const id = this.resolveAgentDispatch(dispatchId);
    const env = this.envelope(id);
    // Obligation: signals whose dispatch is not `running` are DROPPED — stale
    // prior-dispatch hooks (and hooks from user-stopped sessions) die here.
    if (!env || env.status !== "running") return;
    const card = getCard(db, env.cardId);
    if (!card || card.attemptId !== env.attemptId) return; // envelope crossed attempts — stale
    switch (sig.s) {
      case "session-started": {
        this.asidByCard.set(card.id, sig.adapterSessionId);
        const ptyId = this.ptyByDispatch.get(id);
        if (ptyId) setAdapterSessionId(db, ptyId, sig.adapterSessionId);
        const r = this.driveInternal(card, { t: "session-started" });
        if (r && r.card !== card) this.persist(r.card);
        return;
      }
      case "flag": {
        const r = this.driveInternal(card, { t: "flag", kind: sig.kind });
        if (r) this.persist(r.card); // `push` effect: no-op until §11
        return;
      }
      case "flag-clear": {
        const r = this.driveInternal(card, { t: "flag-clear" });
        if (r && r.card !== card) this.persist(r.card); // tolerated double-clear stays silent
        return;
      }
      case "complete-eval": {
        // Truth table: Stop alone never completes. With an accepted
        // task_complete marker it does; without one it is the ordinary
        // end-of-turn → input-needed(question).
        if (pendingComplete(db, id)) this.completeFromApi(id);
        else {
          const r = this.driveInternal(card, { t: "flag", kind: "question" });
          if (r) this.persist(r.card);
        }
        return;
      }
      case "stop-failure": {
        completeDispatch(db, id, "failed");
        setAttemptStatus(db, env.attemptId, "failed");
        const r = this.driveInternal(card, { t: "stop-failure" });
        if (r) this.persist(r.card);
        this.breakerCheck(card.id);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // R3 — completion (called by /api/agent/complete after its dirty-gate,
  // and by complete-eval when the pending marker is set)
  // -------------------------------------------------------------------------

  completeFromApi(dispatchId: string): void {
    const db = this.deps.db;
    const id = this.resolveAgentDispatch(dispatchId);
    // Write-once latch: first caller wins; stale retries are silently dropped.
    const latched = completeDispatch(db, id, "done");
    if (!latched) return;
    const env = this.envelope(id);
    const card = env ? getCard(db, env.cardId) : null;
    if (!env || !card || card.attemptId !== env.attemptId) {
      console.warn(`[engine] completion for dispatch ${id} has no live card/attempt — dropped`);
      return;
    }
    const r = this.driveInternal(card, { t: "complete" }); // stop-vs-complete race → logged drop
    if (!r) return;
    setAttemptStatus(db, env.attemptId, "succeeded");
    this.persist(r.card);
    // Effects: compute-diffstat (v0.2 no-op — diff view computes on demand),
    // push (no-op until §11).
    this.tick(); // R1: the freed slot pulls the next queued card
  }

  // -------------------------------------------------------------------------
  // stop / requeue / cancel
  // -------------------------------------------------------------------------

  /** User ⏹: \x03 to the live PTY (SIGINT to the foreground group), card →
   * working.stopped, dispatch closed as `interrupted` (breaker-neutral) so
   * late hooks from the parked session drop at the status guard. */
  stop(cardId: number): Card {
    const db = this.deps.db;
    const card = getCard(db, cardId);
    if (!card) throw new CardNotFound(cardId);
    const next = transition(card, { t: "user-stop" }, this.deps.clock()); // 409 path
    const ptyId = this.ptyByCard.get(cardId);
    if (ptyId) this.deps.ptys.get(ptyId)?.write("\x03");
    if (card.attemptId !== null) {
      db.query(
        `UPDATE dispatches SET status = 'interrupted' WHERE status = 'running' AND attempt_id = ?1`,
      ).run(card.attemptId);
    }
    return this.persist(next.card);
  }

  /** Drag Running→Queue from stopped/error. Obligation: the worktree is KEPT
   * and PINNED — the machine retains card.worktreeId (that pointer is the
   * pin `ensureWorktree` honors) and the row stays active; `requeue-auto-off`
   * is fully expressed by the persisted auto:false. */
  requeue(cardId: number): Card {
    const card = getCard(this.deps.db, cardId);
    if (!card) throw new CardNotFound(cardId);
    const next = transition(card, { t: "requeue" }, this.deps.clock()); // 409 path
    return this.persist(next.card);
  }

  /** Close without merge. Effects: archive-worktree → interpreted as
   * kill-sessions-THEN-archive (§4.2 I3). Branch kept (14-day policy). */
  async cancel(cardId: number): Promise<Card> {
    const db = this.deps.db;
    const card = getCard(db, cardId);
    if (!card) throw new CardNotFound(cardId);
    const next = transition(card, { t: "cancel" }, this.deps.clock()); // 409 path
    if (card.attemptId !== null) {
      db.query(
        `UPDATE dispatches SET status = 'interrupted' WHERE status = 'running' AND attempt_id = ?1`,
      ).run(card.attemptId);
    }
    const saved = this.persist(next.card);
    await this.applyArchive(saved);
    return saved;
  }

  // -------------------------------------------------------------------------
  // R4 — merge
  // -------------------------------------------------------------------------

  /**
   * Squash-merge the cg branch into base in the MAIN repo checkout, then
   * archive. ATOMICITY SHAPE (review obligation 1): `review.merging` is a trap
   * state — the machine has no merge-failed exit — so ALL fallible git work
   * runs FIRST, against a card still in review.ready; only after the squash
   * commit exists and both refs are updated do we drive `merge-start` →
   * `merged` back-to-back (two legal machine transitions in immediate
   * succession) and run the merged effects. Any git failure throws with the
   * card untouched (route → error, card still mergeable/cancellable).
   */
  async merge(cardId: number): Promise<void> {
    const db = this.deps.db;
    const card = getCard(db, cardId);
    if (!card) throw new CardNotFound(cardId);
    // Legality pre-check via a DISCARDED dry transition: transition() is pure,
    // so this validates review.ready (409 otherwise) with zero side effects.
    transition(card, { t: "merge-start" }, this.deps.clock());
    if (!card.worktreeId) throw new Error("card has no worktree to merge");
    const wt = this.worktreeRow(card.worktreeId);
    if (!wt || wt.state !== "active") throw new Error("card worktree is not active");
    const project = getProject(db, card.projectId);
    if (!project) throw new CardNotFound(`project ${card.projectId}`);
    const repo = project.path;

    // ---- fallible git zone (card still review.ready throughout) ----
    const onBranch = (await git(repo, "symbolic-ref", "--short", "HEAD")).trim();
    if (onBranch !== wt.base) {
      throw new Error(`main checkout is on '${onBranch}' — check out '${wt.base}' to merge`);
    }
    if ((await git(repo, "diff", "--cached", "--name-only")).trim() !== "") {
      throw new Error("main checkout has staged changes — commit or unstage them to merge");
    }
    try {
      await git(repo, "merge", "--squash", wt.branch);
    } catch (e) {
      await git(repo, "reset", "--merge").catch(() => {}); // restore the pre-merge checkout
      throw e;
    }
    let squashSha: string;
    if ((await gitCode(repo, "diff", "--cached", "--quiet")) === 0) {
      // Empty squash (branch adds nothing over base): no commit to make.
      squashSha = (await git(repo, "rev-parse", "HEAD")).trim();
    } else {
      await git(repo, "commit", "--no-verify", "-m", `${card.title} (codegent card ${card.id})`);
      squashSha = (await git(repo, "rev-parse", "HEAD")).trim();
    }
    // VK: reset the task branch ref to the squash commit — ahead/behind vs
    // base becomes 0/0 and follow-ups continue from the merged state.
    // update-ref bypasses the checked-out-in-worktree guard; the worktree is
    // archived right below.
    await git(repo, "update-ref", `refs/heads/${wt.branch}`, squashSha);
    // ---- end fallible zone ----

    // Re-read + drive both machine transitions in immediate succession.
    const fresh = getCard(db, cardId);
    if (!fresh) throw new CardNotFound(cardId);
    const m1 = transition(fresh, { t: "merge-start" }, this.deps.clock());
    this.persist(m1.card); // review.merging (event)
    const m2 = transition(m1.card, { t: "merged" }, this.deps.clock());
    const done = this.persist(m2.card); // done (event)
    // Merges are recorded facts (spec) — a timeline row, Details drawer only.
    appendTimeline(db, cardId, "merge", `merged ${wt.branch} into ${wt.base} @ ${squashSha.slice(0, 12)}`);
    // merged effects [kill-sessions, archive-worktree] dedupe into the single
    // kill-then-archive sequence (obligation 2).
    await this.applyArchive(done);
    // R4: re-check other review cards — v0.2 emits their card events so the
    // UI re-fetches; stale computation lands in v0.3.
    const others = db.query(
      `SELECT id FROM cards WHERE project_id = ?1 AND phase = 'review' AND id != ?2`,
    ).all(card.projectId, cardId) as Array<{ id: number }>;
    for (const o of others) {
      const oc = getCard(db, o.id);
      if (oc) this.deps.events.emit({ t: "card", card: oc });
    }
    this.tick(); // R1 pulls the next card into the freed slot
  }

  // -------------------------------------------------------------------------
  // Send back — review.ready → working.running round+1
  // -------------------------------------------------------------------------

  async sendBack(cardId: number, comments: string[]): Promise<void> {
    const db = this.deps.db;
    const card = getCard(db, cardId);
    if (!card) throw new CardNotFound(cardId);
    const ptyId = this.ptyByCard.get(cardId);
    const sess = ptyId ? this.deps.ptys.get(ptyId) : undefined;
    // Dead-session path needs a spawnable adapter — validate BEFORE any state
    // change so a none-agent card 409s cleanly.
    const adapter = sess ? null : this.adapterFor(card.agent);
    const next = transition(card, { t: "send-back" }, this.deps.clock()); // 409 path
    if (card.attemptId === null) throw new Error("card has no attempt to send back to");
    const round = next.card.round;
    const body = comments.map((c) => `- ${c}`).join("\n");
    appendTimeline(db, cardId, "round",
      comments.length ? `round ${round} sent back:\n${body}` : `round ${round} sent back`);
    setAttemptStatus(db, card.attemptId, "running"); // the attempt is live again
    const saved = this.persist(next.card);
    const dispatch = createDispatch(db, card.attemptId);
    this.routes.set(dispatch.id, dispatch.id);

    if (sess) {
      // LIVE session: same conversation, fresh dispatch. Hooks + sidecar keep
      // the spawn-time session key → alias it onto the new dispatch.
      const key = this.spawnKeyByCard.get(cardId);
      if (key) this.routes.set(key, dispatch.id);
      if (ptyId) this.ptyByDispatch.set(dispatch.id, ptyId);
      const text = sanitizeInjection(
        `Review round ${round}: the task was sent back with the comments below. ` +
          `Address them, commit your work, then call task_complete again.` +
          (body ? `\n${body}` : ""),
      );
      // Orca §6 framing: Ctrl+U first (CC restores interrupted prompts into
      // the composer), one paste, then the submit \r ALONE after a settle.
      sess.write("\x15" + text);
      await Bun.sleep(this.timers.injectSettleMs);
      sess.write("\r");
      return;
    }

    // DEAD session: new dispatch with native resume; comments ride the task
    // prompt (adapter appends extraPrompt — single paste, single submit).
    this.spawnKeyByCard.set(cardId, dispatch.id);
    const project = getProject(db, card.projectId);
    if (!project) throw new CardNotFound(`project ${card.projectId}`);
    const wt = saved.worktreeId ? this.worktreeRow(saved.worktreeId) : null;
    if (!wt) throw new Error("card worktree is gone — cannot resume");
    const attemptRow = db.query(`SELECT * FROM attempts WHERE id = ?1`).get(card.attemptId) as any;
    const attempt: Attempt = {
      id: attemptRow.id, cardId: attemptRow.card_id, worktreeId: attemptRow.worktree_id,
      seq: attemptRow.seq, status: attemptRow.status, beforeHead: attemptRow.before_head,
      createdAt: attemptRow.created_at,
    };
    const resumeSessionId = this.asidByCard.get(cardId)
      ?? ((db.query(
        `SELECT adapter_session_id AS a FROM sessions
         WHERE attempt_id = ?1 AND adapter_session_id IS NOT NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(card.attemptId) as any)?.a ?? null);
    try {
      const res = await this.spawnWithTimeout(adapter!, {
        project, card: saved, attempt, dispatch, worktreePath: wt.path,
        resumeSessionId,
        extraPrompt: `This task was reviewed and sent back (round ${round}). ` +
          `Address the following review comments, commit, then call task_complete again.` +
          (body ? `\n${body}` : ""),
      });
      this.registerSpawn(cardId, dispatch.id, res);
    } catch (e) {
      console.warn(`[engine] send-back respawn failed for card ${cardId}:`, e instanceof Error ? e.message : e);
      completeDispatch(db, dispatch.id, "failed");
      setAttemptStatus(db, card.attemptId, "failed");
      const cur = getCard(db, cardId);
      const r = cur ? this.driveInternal(cur, { t: "crashed" }) : null;
      if (r) this.persist(r.card);
      this.breakerCheck(cardId);
    }
  }

  // -------------------------------------------------------------------------
  // Interval — heartbeat soft-warn + runaway guard (injected clock only)
  // -------------------------------------------------------------------------

  interval(): void {
    const now = this.deps.clock();
    const rows = this.deps.db.query(
      `SELECT d.id AS id, d.created_at AS created_at, d.last_progress_at AS last_progress_at, a.card_id AS card_id
       FROM dispatches d
       JOIN attempts a ON a.id = d.attempt_id
       JOIN cards c ON c.id = a.card_id
       WHERE d.status = 'running' AND c.attempt_id = d.attempt_id
         AND c.phase = 'working' AND c.working_sub = 'running'`,
    ).all() as Array<{ id: string; created_at: number; last_progress_at: number | null; card_id: number }>;
    for (const r of rows) {
      const stamp = r.last_progress_at ?? r.created_at;
      // Soft warning, once per quiet period: re-arms when progress advances.
      if (now - stamp > this.timers.heartbeatWarnMs && this.hbWarned.get(r.id) !== stamp) {
        this.hbWarned.set(r.id, stamp);
        this.deps.events.emit({ t: "notice", cardId: r.card_id, kind: "heartbeat-quiet" });
      }
      // Runaway (>30 min), once per dispatch; its push effect is the §11 no-op hook.
      if (now - r.created_at > this.timers.runawayMs && !this.runawayFired.has(r.id)) {
        this.runawayFired.add(r.id);
        this.deps.events.emit({ t: "notice", cardId: r.card_id, kind: "runaway" });
      }
    }
    // Dedup-map GC: a terminal dispatch can never notice again (the query
    // above filters to running), so its keys are dead weight.
    const live = new Set(rows.map((r) => r.id));
    for (const k of this.hbWarned.keys()) if (!live.has(k)) this.hbWarned.delete(k);
    for (const k of this.runawayFired) if (!live.has(k)) this.runawayFired.delete(k);
  }

  // -------------------------------------------------------------------------
  // Effect helpers
  // -------------------------------------------------------------------------

  /** `archive-worktree`, the standing interpretation (obligation 2): kill the
   * card's sessions FIRST (§4.2 I3), then archive. Idempotent — dead sessions
   * are absent from the live map, an already-archived row is skipped. */
  private async applyArchive(card: Card): Promise<void> {
    await this.killSessionsFor(card);
    if (!card.worktreeId) return;
    const row = this.worktreeRow(card.worktreeId);
    if (!row || row.state !== "active") return;
    const project = getProject(this.deps.db, card.projectId);
    if (!project) return;
    try {
      await archiveWorktree(this.deps.db, project, card.worktreeId);
    } catch (e) {
      // Best-effort: the card's state already landed; a leaked dir is sweep
      // fodder, not a reason to wedge the card.
      console.warn(`[engine] worktree archive failed for card ${card.id}:`, e instanceof Error ? e.message : e);
    }
  }

  /** Terminate (full §6.1 ladder) every live session tied to the card: its
   * tracked agent PTY plus every live session row in its worktree (shells). */
  private async killSessionsFor(card: Card): Promise<void> {
    const ids = new Set<string>();
    const tracked = this.ptyByCard.get(card.id);
    if (tracked) ids.add(tracked);
    if (card.worktreeId) {
      const rows = this.deps.db.query(
        `SELECT id FROM sessions WHERE worktree_id = ?1 AND live = 1`,
      ).all(card.worktreeId) as Array<{ id: string }>;
      for (const r of rows) ids.add(r.id);
    }
    await Promise.all(
      [...ids].map(async (id) => {
        const s = this.deps.ptys.get(id);
        if (s) await s.terminate().catch(() => {});
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Hook-plane wiring
  // -------------------------------------------------------------------------

  /** Subscribe to the T6 receiver: normalize per-agent, feed handleSignal.
   * The hook plane is fail-open — nothing thrown here may escape. */
  attachHooks(rx: {
    onHook(cb: (h: { agent: string; sessionId: string | null; event: unknown }) => void): () => void;
  }): () => void {
    return rx.onHook((h) => {
      if (!h.sessionId) return;
      const adapter =
        h.agent === "claude" || h.agent === "codex" ? this.deps.adapters[h.agent] : null;
      if (!adapter) return;
      let sigs: AdapterSignal[];
      try {
        sigs = adapter.onHook(h.sessionId, h.event);
      } catch {
        return;
      }
      for (const sig of sigs) {
        try {
          this.handleSignal(h.sessionId, sig);
        } catch (e) {
          console.warn("[engine] handleSignal failed:", e instanceof Error ? e.message : e);
        }
      }
    });
  }
}
