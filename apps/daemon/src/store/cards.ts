import type { Database } from "bun:sqlite";
import type { Card } from "@codegent/protocol";

const rowToCard = (r: any): Card => ({
  id: r.id, projectId: r.project_id, title: r.title, body: r.body, phase: r.phase,
  agent: r.agent, worktreeId: r.worktree_id, position: r.position,
  createdAt: r.created_at, updatedAt: r.updated_at,
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

const PATCHABLE = ["title", "body", "phase", "position", "agent", "worktreeId"] as const;
const COL: Record<string, string> = { worktreeId: "worktree_id" };

export function updateCard(db: Database, id: number, patch: Partial<Pick<Card, (typeof PATCHABLE)[number]>>): Card {
  const sets: string[] = []; const vals: any[] = [];
  for (const k of PATCHABLE) if (k in patch) { sets.push(`${COL[k] ?? k} = ?${vals.length + 2}`); vals.push((patch as any)[k]); }
  sets.push(`updated_at = ?${vals.length + 2}`); vals.push(Date.now());
  const row = db.query(`UPDATE cards SET ${sets.join(", ")} WHERE id = ?1 RETURNING *`).get(id, ...vals) as any;
  if (!row) throw new Error(`card ${id} not found`);
  return rowToCard(row);
}

export function deleteCard(db: Database, id: number): void {
  db.query(`DELETE FROM cards WHERE id = ?1`).run(id);
}

export function listCards(db: Database, projectId: string): Card[] {
  return db.query(`SELECT * FROM cards WHERE project_id = ?1 ORDER BY phase, position`).all(projectId).map(rowToCard);
}
