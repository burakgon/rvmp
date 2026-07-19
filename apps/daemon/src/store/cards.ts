import type { Database } from "bun:sqlite";
import type { Card } from "@codegent/protocol";

const rowToCard = (r: any): Card => ({
  id: r.id, projectId: r.project_id, title: r.title, body: r.body,
  phase: r.phase, agent: r.agent, worktreeId: r.worktree_id, position: r.position,
  createdAt: r.created_at, updatedAt: r.updated_at,
  workingSub: r.working_sub, errorKind: r.error_kind, reviewSub: r.review_sub,
  inputKind: r.input_kind, inputSince: r.input_since,
  round: r.round, auto: !!r.auto, attemptId: r.attempt_id,
});

export function createCard(db: Database, c: { projectId: string; title: string; body: string; agent: Card["agent"] }): Card {
  const now = Date.now();
  const max = db.query(`SELECT COALESCE(MAX(position), 0) AS m FROM cards WHERE project_id = ?1`).get(c.projectId) as any;
  const res = db.query(
    `INSERT INTO cards (project_id, title, body, agent, position, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING *`
  ).get(c.projectId, c.title, c.body, c.agent, max.m + 1, now) as any;
  return rowToCard(res);
}

// Store-level patch surface (used by the engine). The HTTP layer exposes a
// deliberately narrower pick (server.ts CardPatchBody) — orchestration fields
// are engine-written only, never user-patchable.
const PATCHABLE = [
  "title", "body", "phase", "position", "agent", "worktreeId",
  "workingSub", "errorKind", "reviewSub", "inputKind", "inputSince",
  "round", "auto", "attemptId",
] as const;
const COL: Record<string, string> = {
  worktreeId: "worktree_id", workingSub: "working_sub", errorKind: "error_kind",
  reviewSub: "review_sub", inputKind: "input_kind", inputSince: "input_since",
  attemptId: "attempt_id",
};

export function updateCard(db: Database, id: number, patch: Partial<Pick<Card, (typeof PATCHABLE)[number]>>): Card {
  const sets: string[] = []; const vals: any[] = [];
  for (const k of PATCHABLE) if (k in patch) {
    const v = (patch as any)[k];
    sets.push(`${COL[k] ?? k} = ?${vals.length + 2}`);
    vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
  }
  sets.push(`updated_at = ?${vals.length + 2}`); vals.push(Date.now());
  const row = db.query(`UPDATE cards SET ${sets.join(", ")} WHERE id = ?1 RETURNING *`).get(id, ...vals) as any;
  if (!row) throw new Error(`card ${id} not found`);
  return rowToCard(row);
}

export function getCard(db: Database, id: number): Card | null {
  const r = db.query(`SELECT * FROM cards WHERE id = ?1`).get(id) as any;
  return r ? rowToCard(r) : null;
}

export function deleteCard(db: Database, id: number): void {
  db.query(`DELETE FROM cards WHERE id = ?1`).run(id);
}

export function listCards(db: Database, projectId: string): Card[] {
  return db.query(`SELECT * FROM cards WHERE project_id = ?1 ORDER BY phase, position`).all(projectId).map(rowToCard);
}
