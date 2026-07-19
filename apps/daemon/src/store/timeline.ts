import type { Database } from "bun:sqlite";

export type TimelineKind = "progress" | "round" | "merge";

export interface TimelineEntry {
  id: number;
  cardId: number;
  ts: number;
  kind: TimelineKind;
  text: string;
}

const rowToEntry = (r: any): TimelineEntry => ({
  id: r.id, cardId: r.card_id, ts: r.ts, kind: r.kind, text: r.text,
});

/**
 * Append one timeline row (`progress` from the agent's task_progress calls,
 * `round` for round history — completion summaries and send-back comments,
 * `merge` for the engine's recorded merge facts). Timeline text renders ONLY
 * in the card's Details drawer (spec §7.3), never on card faces, and nothing
 * here emits domain events — the drawer reads it on demand.
 */
export function appendTimeline(db: Database, cardId: number, kind: TimelineKind, text: string): TimelineEntry {
  const row = db.query(
    `INSERT INTO timeline (card_id, ts, kind, text) VALUES (?1, ?2, ?3, ?4) RETURNING *`,
  ).get(cardId, Date.now(), kind, text) as any;
  return rowToEntry(row);
}

export function listTimeline(db: Database, cardId: number): TimelineEntry[] {
  return db.query(`SELECT * FROM timeline WHERE card_id = ?1 ORDER BY id`).all(cardId).map(rowToEntry);
}

/** Latest agent progress note for a card — the resume-fallback context block's
 * input (T9). Like all timeline text it may reach the AGENT's prompt, never
 * card faces or events. */
export function lastProgressNote(db: Database, cardId: number): string | null {
  const r = db.query(
    `SELECT text FROM timeline WHERE card_id = ?1 AND kind = 'progress' ORDER BY id DESC LIMIT 1`,
  ).get(cardId) as any;
  return r?.text ?? null;
}
