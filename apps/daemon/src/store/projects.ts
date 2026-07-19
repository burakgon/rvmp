import type { Database } from "bun:sqlite";
import type { Project } from "@codegent/protocol";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const rowToProject = (r: any): Project => ({
  id: r.id, name: r.name, path: r.path, baseBranch: r.base_branch, createdAt: r.created_at,
});

export function createProject(db: Database, p: { name: string; path: string; baseBranch: string }): Project {
  const id = `${slug(p.name)}-${crypto.randomUUID().slice(0, 4)}`;
  const now = Date.now();
  db.query(`INSERT INTO projects (id, name, path, base_branch, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .run(id, p.name, p.path, p.baseBranch, now);
  return { id, name: p.name, path: p.path, baseBranch: p.baseBranch, createdAt: now };
}

export function listProjects(db: Database): Project[] {
  return db.query(`SELECT * FROM projects ORDER BY created_at`).all().map(rowToProject);
}
