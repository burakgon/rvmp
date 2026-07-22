import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseIntegrity, ensureDailyBackup, listBackups, openDb } from "../src/store/db";

const dir = mkdtempSync(join(tmpdir(), "rvmp-db-backup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("database integrity and consistent backup rotation retain seven snapshots", () => {
  const path = join(dir, "db.sqlite");
  const db = openDb(path);
  db.query(`INSERT INTO projects (id, name, path, base_branch, created_at) VALUES ('p','P','/tmp/p','main',1)`).run();
  expect(databaseIntegrity(db)).toEqual({ ok: true, detail: "ok" });
  const manual = ensureDailyBackup(db, path, new Date("2026-07-23T12:34:56Z"), true);
  expect(Bun.file(manual).size).toBeGreaterThan(0);
  for (let day = 1; day <= 10; day++) ensureDailyBackup(db, path, new Date(`2026-08-${String(day).padStart(2, "0")}T00:00:00Z`));
  const backups = listBackups(path);
  expect(backups).toHaveLength(7);
  expect(backups[0]).toBe("rvmp-2026-08-10.sqlite");
  db.close();
});
