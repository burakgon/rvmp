import { Database } from "bun:sqlite";

export const MIGRATIONS = [
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
  // v0.2 orchestration: card sub-state columns, attempts/dispatches, agent sessions.
  // The two UPDATEs reproduce exactly what the cards.ts READ-SHIM used to fake at
  // read time, so removing the shim is lossless for v0.1 rows.
  `ALTER TABLE cards ADD COLUMN working_sub TEXT;
   ALTER TABLE cards ADD COLUMN error_kind TEXT;
   ALTER TABLE cards ADD COLUMN review_sub TEXT;
   ALTER TABLE cards ADD COLUMN input_kind TEXT;
   ALTER TABLE cards ADD COLUMN input_since INTEGER;
   ALTER TABLE cards ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE cards ADD COLUMN auto INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE cards ADD COLUMN attempt_id INTEGER;
   UPDATE cards SET phase = 'working', working_sub = 'running' WHERE phase = 'running';
   UPDATE cards SET phase = 'working', input_kind = 'silent',
     input_since = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE phase = 'waiting';
   CREATE TABLE attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL REFERENCES cards(id),
     worktree_id TEXT, seq INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running',
     before_head TEXT, created_at INTEGER NOT NULL,
     UNIQUE (card_id, seq));
   CREATE TABLE dispatches (
     id TEXT PRIMARY KEY, attempt_id INTEGER NOT NULL REFERENCES attempts(id),
     status TEXT NOT NULL DEFAULT 'running', last_progress_at INTEGER,
     created_at INTEGER NOT NULL);
   ALTER TABLE sessions ADD COLUMN adapter_session_id TEXT;
   ALTER TABLE sessions ADD COLUMN attempt_id INTEGER;`,
];

export function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY);`);
  const done = new Set(db.query(`SELECT idx FROM _migrations`).all().map((r: any) => r.idx));
  MIGRATIONS.forEach((sql, idx) => {
    if (!done.has(idx)) {
      // Each migration applies atomically with its ledger row: a mid-migration
      // crash rolls back, so it re-runs cleanly on the next boot.
      db.transaction(() => {
        db.exec(sql);
        db.query(`INSERT INTO _migrations (idx) VALUES (?1)`).run(idx);
      })();
    }
  });
  return db;
}
