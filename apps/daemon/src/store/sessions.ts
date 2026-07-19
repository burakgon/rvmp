import type { Database } from "bun:sqlite";
import type { SessionMeta } from "@codegent/protocol";

const rowToMeta = (r: any): SessionMeta => ({
  id: r.id, projectId: r.project_id, kind: r.kind, title: r.title,
  cwd: r.cwd, worktreeId: r.worktree_id, live: !!r.live, createdAt: r.created_at,
  adapterSessionId: r.adapter_session_id, attemptId: r.attempt_id,
});

export function insertSession(db: Database, m: SessionMeta): void {
  db.query(`INSERT INTO sessions (id, project_id, kind, title, cwd, worktree_id, live, created_at, adapter_session_id, attempt_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .run(m.id, m.projectId, m.kind, m.title, m.cwd, m.worktreeId, m.live ? 1 : 0, m.createdAt,
         m.adapterSessionId ?? null, m.attemptId ?? null);
}

export function setSessionLive(db: Database, id: string, live: boolean): void {
  db.query(`UPDATE sessions SET live = ?2 WHERE id = ?1`).run(id, live ? 1 : 0);
}

/** Resume bookkeeping (spec §4.3): the agent CLI's own session uuid, captured
 * from its SessionStart hook, keyed by our PTY session id. */
export function setAdapterSessionId(db: Database, id: string, adapterSessionId: string): void {
  db.query(`UPDATE sessions SET adapter_session_id = ?2 WHERE id = ?1`).run(id, adapterSessionId);
}

export function listSessions(db: Database, projectId: string): SessionMeta[] {
  return db.query(`SELECT * FROM sessions WHERE project_id = ?1 ORDER BY created_at`)
    .all(projectId).map(rowToMeta);
}
