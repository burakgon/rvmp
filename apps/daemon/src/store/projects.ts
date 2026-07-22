import type { Database } from "bun:sqlite";
import type { Project } from "@rvmp/protocol";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const rowToProject = (r: any): Project => ({
  id: r.id, name: r.name, path: r.path, baseBranch: r.base_branch, createdAt: r.created_at,
  workerLimit: r.worker_limit ?? 1,
  defaultAgent: r.default_agent ?? null,
  setupScript: r.setup_script ?? "",
  copyGlobs: JSON.parse(r.copy_globs ?? "[]"),
  mode: r.mode ?? "auto",
});

export function createProject(db: Database, p: { name: string; path: string; baseBranch: string; pathKey?: string }): Project {
  const id = `${slug(p.name)}-${crypto.randomUUID().slice(0, 4)}`;
  const now = Date.now();
  db.query(`INSERT INTO projects (id, name, path, path_key, base_branch, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .run(id, p.name, p.path, p.pathKey ?? null, p.baseBranch, now);
  return {
    id, name: p.name, path: p.path, baseBranch: p.baseBranch, createdAt: now, workerLimit: 1,
    defaultAgent: null, setupScript: "", copyGlobs: [], mode: "auto",
  };
}

/** §8 project settings (Part 4) — engine reads these on every worktree create. */
export function updateProjectSettings(
  db: Database, id: string,
  patch: Partial<Pick<Project, "name" | "baseBranch" | "defaultAgent" | "setupScript" | "copyGlobs" | "mode">>,
): Project | null {
  const cur = getProject(db, id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.query(`UPDATE projects SET name = ?2, base_branch = ?3, default_agent = ?4, setup_script = ?5, copy_globs = ?6, mode = ?7 WHERE id = ?1`)
    .run(id, next.name, next.baseBranch, next.defaultAgent, next.setupScript, JSON.stringify(next.copyGlobs), next.mode);
  return getProject(db, id);
}

export function getProject(db: Database, id: string): Project | null {
  const r = db.query(`SELECT * FROM projects WHERE id = ?1`).get(id) as any;
  return r ? rowToProject(r) : null;
}

export function setWorkerLimit(db: Database, id: string, n: number): Project | null {
  const r = db.query(`UPDATE projects SET worker_limit = ?2 WHERE id = ?1 RETURNING *`).get(id, n) as any;
  return r ? rowToProject(r) : null;
}

export function listProjects(db: Database): Project[] {
  return db.query(`SELECT * FROM projects ORDER BY created_at`).all().map(rowToProject);
}

export function projectForPath(db: Database, path: string, pathKey: string): Project | null {
  const r = db.query(`SELECT * FROM projects WHERE path_key = ?1 OR path = ?2 LIMIT 1`).get(pathKey, path) as any;
  return r ? rowToProject(r) : null;
}

/** Detach application state only. Files, repositories, branches and worktree
 * directories are intentionally outside this transaction. */
export function deleteProjectRecords(db: Database, id: string): boolean {
  return db.transaction(() => {
    const exists = db.query(`SELECT 1 AS ok FROM projects WHERE id = ?1`).get(id);
    if (!exists) return false;
    db.query(`DELETE FROM card_file_reviews WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?1)`).run(id);
    db.query(`DELETE FROM timeline WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?1)`).run(id);
    db.query(`DELETE FROM dispatches WHERE attempt_id IN (SELECT id FROM attempts WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?1))`).run(id);
    db.query(`DELETE FROM attempts WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?1)`).run(id);
    db.query(`DELETE FROM sessions WHERE project_id = ?1`).run(id);
    db.query(`DELETE FROM worktrees WHERE project_id = ?1`).run(id);
    db.query(`DELETE FROM event_log WHERE project_id = ?1`).run(id);
    db.query(`DELETE FROM cards WHERE project_id = ?1`).run(id);
    db.query(`DELETE FROM projects WHERE id = ?1`).run(id);
    return true;
  })();
}
