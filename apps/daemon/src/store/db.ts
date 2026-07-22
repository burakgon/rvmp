import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

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
  // The two UPDATEs apply the T2 brief's mandated v0.1->v0.2 mapping. It matches the
  // retired cards.ts READ-SHIM except input_since: the shim faked null, while the
  // brief mandates input_since=<now> for migrated waiting cards (intentional).
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
  // v0.2 signal plane (T6): per-card timeline (progress notes + round history —
  // Details-drawer-only per spec §7.3, never card faces) and the pre-engine
  // pending-complete marker: a gate-passed task_complete recorded store-side on
  // the still-running dispatch. T8's complete-eval consumes it; until then no
  // card transition happens on completion.
  `CREATE TABLE timeline (
     id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL REFERENCES cards(id),
     ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
   ALTER TABLE dispatches ADD COLUMN pending_complete INTEGER NOT NULL DEFAULT 0;`,
  // v0.2 orchestrator (T8): R1's per-project slot count (spec §5, default 1).
  `ALTER TABLE projects ADD COLUMN worker_limit INTEGER NOT NULL DEFAULT 1;`,
  // v0.2 recovery (T9): execution mode persisted per attempt at spawn (spec
  // §9.1 — resume/restart must re-pass the ORIGINAL flags, never a compiled-in
  // default). Values: auto|host|ask; pre-migration rows read as 'auto', which
  // is what every v0.2 spawn actually used.
  `ALTER TABLE attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto';`,
  // v0.3 Part 3 review foundations: queue ordering/PR state, worktree
  // base-sync state, and per-file viewed marks.
  `ALTER TABLE cards ADD COLUMN ready_since INTEGER;
   ALTER TABLE cards ADD COLUMN pr_number INTEGER;
   ALTER TABLE cards ADD COLUMN pr_url TEXT;
   ALTER TABLE cards ADD COLUMN pr_state TEXT;
   ALTER TABLE cards ADD COLUMN ci_status TEXT;
   ALTER TABLE worktrees ADD COLUMN sync TEXT NOT NULL DEFAULT 'clean';
   ALTER TABLE worktrees ADD COLUMN behind_count INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE card_file_reviews (
     card_id INTEGER NOT NULL, path TEXT NOT NULL, viewed_at INTEGER NOT NULL,
     PRIMARY KEY (card_id, path));`,
  // 9 — Part-3 review fixes: the recorded local-merge commit (done-card diff identity)
  `ALTER TABLE cards ADD COLUMN merge_sha TEXT;`,
  // 10 — Part-4 project settings: composer default, worktree bootstrap, execution mode
  `ALTER TABLE projects ADD COLUMN default_agent TEXT;
   ALTER TABLE projects ADD COLUMN setup_script TEXT NOT NULL DEFAULT '';
   ALTER TABLE projects ADD COLUMN copy_globs TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto';`,
  // 11 — Part-4 event log (§8: "what happened while I slept", 30-day retention)
  `CREATE TABLE event_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     project_id TEXT NOT NULL,
     card_id INTEGER,
     kind TEXT NOT NULL,
     title TEXT NOT NULL);
   CREATE INDEX idx_event_log_project ON event_log(project_id, id);`,
  // 12 — lifecycle + per-card execution policy. Existing project rows keep a
  // null path_key so old duplicate registrations do not make the migration
  // destructive; every newly-created row receives a canonical unique key.
  `ALTER TABLE cards ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'inherit';
   ALTER TABLE projects ADD COLUMN path_key TEXT;
   CREATE UNIQUE INDEX idx_projects_path_key ON projects(path_key) WHERE path_key IS NOT NULL;`,
  // 13 — browser-closed notifications. VAPID private material stays in a
  // mode-0600 file; only browser endpoint/encryption keys live in SQLite.
  `CREATE TABLE push_subscriptions (
     endpoint TEXT PRIMARY KEY,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at INTEGER NOT NULL);`,
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
  // Existing installs may predate canonical path keys. Backfill every
  // non-conflicting live path; legacy duplicates remain readable but cannot
  // cause a destructive migration failure.
  const legacyPaths = db.query(`SELECT id, path FROM projects WHERE path_key IS NULL`).all() as Array<{ id: string; path: string }>;
  for (const row of legacyPaths) {
    try {
      const key = realpathSync(row.path);
      db.query(`UPDATE OR IGNORE projects SET path_key = ?2 WHERE id = ?1`).run(row.id, key);
    } catch { /* moved/offline repositories stay detachable and re-addable */ }
  }
  if (path !== ":memory:") ensureDailyBackup(db, path);
  return db;
}

export function databaseIntegrity(db: Database): { ok: boolean; detail: string } {
  const rows = db.query(`PRAGMA integrity_check`).all() as Array<Record<string, string>>;
  const values = rows.flatMap(row => Object.values(row));
  return { ok: values.length === 1 && values[0] === "ok", detail: values.join("; ") || "no result" };
}

export function listBackups(dbPath: string): string[] {
  const dir = join(dirname(dbPath), "backups");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^rvmp-\d{4}-\d{2}-\d{2}(?:-\d{6})?\.sqlite$/.test(name)).sort().reverse();
}

/** SQLite's VACUUM INTO creates a consistent standalone snapshot even while
 * the live database uses WAL. Daily boot snapshots retain the newest seven. */
export function ensureDailyBackup(db: Database, dbPath: string, now = new Date(), force = false): string {
  const dir = join(dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const name = force ? `rvmp-${day}-${time}.sqlite` : `rvmp-${day}.sqlite`;
  const target = join(dir, name);
  if (!existsSync(target)) {
    db.query(`VACUUM INTO ?1`).run(target);
    chmodSync(target, 0o600);
  }
  for (const stale of listBackups(dbPath).slice(7)) rmSync(join(dir, stale), { force: true });
  return target;
}
