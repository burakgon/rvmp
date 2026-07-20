import type { Database } from "bun:sqlite";

export function listReviewedFiles(db: Database, cardId: number): string[] {
  return (db.query(
    `SELECT path FROM card_file_reviews WHERE card_id = ?1 ORDER BY path`,
  ).all(cardId) as Array<{ path: string }>).map(row => row.path);
}

export function setReviewed(db: Database, cardId: number, path: string, viewed: boolean): void {
  if (!viewed) {
    db.query(`DELETE FROM card_file_reviews WHERE card_id = ?1 AND path = ?2`).run(cardId, path);
    return;
  }
  db.query(
    `INSERT INTO card_file_reviews (card_id, path, viewed_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (card_id, path) DO UPDATE SET viewed_at = excluded.viewed_at`,
  ).run(cardId, path, Date.now());
}

export function invalidateReviewed(db: Database, cardId: number, paths: string[]): void {
  if (paths.length === 0) return;
  const remove = db.query(`DELETE FROM card_file_reviews WHERE card_id = ?1 AND path = ?2`);
  db.transaction(() => {
    for (const path of new Set(paths)) remove.run(cardId, path);
  })();
}

export function clearReviewed(db: Database, cardId: number): void {
  db.query(`DELETE FROM card_file_reviews WHERE card_id = ?1`).run(cardId);
}
