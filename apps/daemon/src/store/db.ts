import { Database } from "bun:sqlite";

const MIGRATIONS = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
     base_branch TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE TABLE cards (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
     title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', phase TEXT NOT NULL DEFAULT 'queued',
     agent TEXT NOT NULL DEFAULT 'none', worktree_id TEXT, position REAL NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'shell',
     title TEXT NOT NULL, cwd TEXT NOT NULL, worktree_id TEXT,
     live INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);`,
  `CREATE TABLE worktrees (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL,
     path TEXT NOT NULL, base TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');`,
];

export function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY);`);
  const done = new Set(db.query(`SELECT idx FROM _migrations`).all().map((r: any) => r.idx));
  MIGRATIONS.forEach((sql, idx) => {
    if (!done.has(idx)) {
      db.exec(sql);
      db.query(`INSERT INTO _migrations (idx) VALUES (?1)`).run(idx);
    }
  });
  return db;
}
