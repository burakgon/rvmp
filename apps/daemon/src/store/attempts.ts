import type { Database } from "bun:sqlite";
import type { Attempt, Dispatch } from "@codegent/protocol";

const rowToAttempt = (r: any): Attempt => ({
  id: r.id, cardId: r.card_id, worktreeId: r.worktree_id, seq: r.seq,
  status: r.status, beforeHead: r.before_head, createdAt: r.created_at,
});

const rowToDispatch = (r: any): Dispatch => ({
  id: r.id, attemptId: r.attempt_id, status: r.status,
  lastProgressAt: r.last_progress_at, createdAt: r.created_at,
});

export function createAttempt(db: Database, a: { cardId: number; worktreeId: string | null; beforeHead: string | null }): Attempt {
  const row = db.query(
    `INSERT INTO attempts (card_id, worktree_id, seq, status, before_head, created_at)
     VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM attempts WHERE card_id = ?1), 'running', ?3, ?4)
     RETURNING *`
  ).get(a.cardId, a.worktreeId, a.beforeHead, Date.now()) as any;
  return rowToAttempt(row);
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
