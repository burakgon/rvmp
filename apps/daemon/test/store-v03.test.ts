import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/store/db";
import { listCards } from "../src/store/cards";

const V2_MIGRATION_COUNT = 8; // MIGRATIONS[0..7] are the pre-Part-3 schema
const tmp = mkdtempSync(join(tmpdir(), "codegent-store-v03-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function seedV7Db(path: string): void {
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode=WAL;");
  raw.exec("CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY);");
  MIGRATIONS.slice(0, V2_MIGRATION_COUNT).forEach((sql, idx) => {
    raw.exec(sql);
    raw.query("INSERT INTO _migrations (idx) VALUES (?1)").run(idx);
  });
  raw.query(
    "INSERT INTO projects (id, name, path, base_branch, created_at, worker_limit) VALUES ('p1', 'P', '/tmp/p', 'main', 100, 1)",
  ).run();
  raw.query(
    `INSERT INTO cards (
       id, project_id, title, body, phase, agent, position, created_at, updated_at,
       working_sub, error_kind, review_sub, input_kind, input_since, round, auto, attempt_id
     ) VALUES (7, 'p1', 'preserved', '', 'review', 'claude', 1, 100, 100,
       NULL, NULL, 'ready', NULL, NULL, 2, 1, NULL)`,
  ).run();
  raw.query(
    "INSERT INTO worktrees (id, project_id, branch, path, base, state) VALUES ('w1', 'p1', 'cg/7-preserved', '/tmp/w1', 'main', 'active')",
  ).run();
  raw.close();
}

test("migration 8 preserves a v7 database and defaults new worktree sync fields", () => {
  const path = join(tmp, "migrate-v8.db");
  seedV7Db(path);
  const db = openDb(path);

  const [card] = listCards(db, "p1");
  expect(card).toMatchObject({
    id: 7, title: "preserved", phase: "review", reviewSub: "ready", round: 2,
    readySince: null, prNumber: null, prUrl: null, prState: null, ciStatus: null,
  });
  expect(db.query("SELECT sync, behind_count FROM worktrees WHERE id = 'w1'").get())
    .toEqual({ sync: "clean", behind_count: 0 });
  expect((db.query("SELECT COUNT(*) AS n FROM card_file_reviews").get() as { n: number }).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number }).n).toBe(9);
  db.close();
});
