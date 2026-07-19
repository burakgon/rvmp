import type { Database } from "bun:sqlite";
import type { Attempt, Dispatch } from "@codegent/protocol";

/** Execution mode persisted per attempt at spawn (spec §9.1): resume/restart
 * re-pass the ORIGINAL flags. Structurally identical to the agent layer's
 * `AgentMode` — the store deliberately declares its own copy rather than
 * importing upward from `agents/`. */
export type AttemptMode = "auto" | "host" | "ask";

const rowToAttempt = (r: any): Attempt => ({
  id: r.id, cardId: r.card_id, worktreeId: r.worktree_id, seq: r.seq,
  status: r.status, beforeHead: r.before_head, createdAt: r.created_at,
});

const rowToDispatch = (r: any): Dispatch => ({
  id: r.id, attemptId: r.attempt_id, status: r.status,
  lastProgressAt: r.last_progress_at, createdAt: r.created_at,
});

export function createAttempt(
  db: Database,
  a: { cardId: number; worktreeId: string | null; beforeHead: string | null; mode?: AttemptMode },
): Attempt {
  const row = db.query(
    `INSERT INTO attempts (card_id, worktree_id, seq, status, before_head, mode, created_at)
     VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM attempts WHERE card_id = ?1), 'running', ?3, ?4, ?5)
     RETURNING *`
  ).get(a.cardId, a.worktreeId, a.beforeHead, a.mode ?? "auto", Date.now()) as any;
  return rowToAttempt(row);
}

/** The attempt row plus its persisted execution mode (T9 resume/restart input;
 * pre-migration rows read as 'auto' — the only mode v0.2 ever spawned). */
export function getAttempt(db: Database, id: number): (Attempt & { mode: AttemptMode }) | null {
  const r = db.query(`SELECT * FROM attempts WHERE id = ?1`).get(id) as any;
  return r ? { ...rowToAttempt(r), mode: (r.mode ?? "auto") as AttemptMode } : null;
}

export function createDispatch(db: Database, attemptId: number): Dispatch {
  const row = db.query(
    `INSERT INTO dispatches (id, attempt_id, status, created_at)
     VALUES (?1, ?2, 'running', ?3) RETURNING *`
  ).get(crypto.randomUUID(), attemptId, Date.now()) as any;
  return rowToDispatch(row);
}

/**
 * Write-once latch: only a `running` dispatch can be completed. The first
 * caller wins and gets the updated row; every later caller gets null and must
 * treat its result as stale (drop it, don't retry).
 */
export function completeDispatch(db: Database, dispatchId: string, status: Exclude<Dispatch["status"], "running">): Dispatch | null {
  const row = db.query(
    `UPDATE dispatches SET status = ?2 WHERE id = ?1 AND status = 'running' RETURNING *`
  ).get(dispatchId, status) as any;
  return row ? rowToDispatch(row) : null;
}

/** Heartbeat from the adapter; ignored once the dispatch is terminal (latch). */
export function touchDispatchProgress(db: Database, dispatchId: string, ts: number): void {
  db.query(`UPDATE dispatches SET last_progress_at = ?2 WHERE id = ?1 AND status = 'running'`)
    .run(dispatchId, ts);
}

/** Boot recovery: any dispatch still `running` belonged to a dead daemon. */
export function failRunningDispatches(db: Database): number {
  return db.query(`UPDATE dispatches SET status = 'failed' WHERE status = 'running'`).run().changes;
}

/** Boot recovery, sibling sweep: any attempt still `running` belonged to a
 * dead daemon too (deliberately `failed`, not `discarded` — nothing superseded
 * it; the daemon died under it). */
export function failRunningAttempts(db: Database): number {
  return db.query(`UPDATE attempts SET status = 'failed' WHERE status = 'running'`).run().changes;
}

export function setAttemptStatus(db: Database, id: number, status: Attempt["status"]): void {
  db.query(`UPDATE attempts SET status = ?2 WHERE id = ?1`).run(id, status);
}

/** Engine (T8): the attempt row is created before the worktree so every
 * failure mode past this point counts toward the circuit breaker; the
 * worktree binding + before-HEAD land here once the tree exists. */
export function setAttemptWorktree(db: Database, id: number, worktreeId: string, beforeHead: string | null): void {
  db.query(`UPDATE attempts SET worktree_id = ?2, before_head = ?3 WHERE id = ?1`).run(id, worktreeId, beforeHead);
}

/**
 * Supersede rule (T8 start): a fresh start closes any prior still-`running`
 * attempt of the card as `discarded` — deliberately NOT `failed`, so a
 * user-stop → requeue → restart chain never feeds the circuit breaker — and
 * interrupts their leftover running dispatches (signal-guard hygiene).
 */
export function supersedeRunningAttempts(db: Database, cardId: number): void {
  db.query(
    `UPDATE dispatches SET status = 'interrupted'
     WHERE status = 'running' AND attempt_id IN (SELECT id FROM attempts WHERE card_id = ?1 AND status = 'running')`,
  ).run(cardId);
  db.query(`UPDATE attempts SET status = 'discarded' WHERE card_id = ?1 AND status = 'running'`).run(cardId);
}

/**
 * Pre-engine completion path (T6): record a gate-passed `task_complete` as a
 * pending-complete marker WITHOUT transitioning anything. Guarded by the same
 * write-once discipline as `completeDispatch`: only a still-running dispatch
 * accepts it; a stale retry against a terminal dispatch returns false and is
 * dropped. T8's complete-eval reads the marker via `pendingComplete`.
 */
export function markPendingComplete(db: Database, dispatchId: string): boolean {
  return db.query(`UPDATE dispatches SET pending_complete = 1 WHERE id = ?1 AND status = 'running'`)
    .run(dispatchId).changes > 0;
}

/** Did an accepted task_complete arrive for this dispatch? (Engine's complete-eval input.) */
export function pendingComplete(db: Database, dispatchId: string): boolean {
  const r = db.query(`SELECT pending_complete FROM dispatches WHERE id = ?1`).get(dispatchId) as any;
  return !!r?.pending_complete;
}
