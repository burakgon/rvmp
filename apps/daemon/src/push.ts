import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, DomainEvent } from "@rvmp/protocol";
import webpush, { type PushSubscription, type VapidKeys } from "web-push";
import { listCards } from "./store/cards";
import { listProjects } from "./store/projects";

export type StoredSubscription = PushSubscription & { createdAt: number };
export type PushSender = typeof webpush.sendNotification;

const KEY_FILE = "push-keys.json";

/** One stable VAPID identity per rvmp data directory. Rotating it would make
 * every existing browser subscription unusable, so a malformed existing file
 * is an explicit startup/state error rather than silently generating anew. */
export function loadVapidKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, KEY_FILE);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
    if (typeof parsed.publicKey !== "string" || typeof parsed.privateKey !== "string") {
      throw new Error("push-keys.json is malformed");
    }
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return keys;
}

export function savePushSubscription(db: Database, subscription: PushSubscription): void {
  db.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now());
}

export function deletePushSubscription(db: Database, endpoint: string): boolean {
  return db.query(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).run(endpoint).changes > 0;
}

export function listPushSubscriptions(db: Database): StoredSubscription[] {
  return (db.query(`SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions ORDER BY created_at`).all() as Array<{
    endpoint: string; p256dh: string; auth: string; created_at: number;
  }>).map(row => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth }, createdAt: row.created_at }));
}

type Attention = "waiting" | "error" | "review-ready";

const attentionOf = (card: Card): Attention | null => {
  if (card.phase === "working" && card.workingSub === "error") return "error";
  if (card.phase === "working" && card.inputKind !== null) return "waiting";
  if (card.phase === "review" && card.reviewSub === "ready") return "review-ready";
  return null;
};

const label = (attention: Attention): string => attention === "waiting"
  ? "waiting for input"
  : attention === "error" ? "error" : "ready for review";

/** Sends only attention-state entries, never repeats or terminal content.
 * Existing card states seed the dedupe map so daemon startup alone cannot
 * replay old notifications; boot reconciliation can still notify a new error. */
export class PushNotifier {
  readonly publicKey: string;
  private readonly last = new Map<number, Attention | null>();
  private readonly projectByCard = new Map<number, string>();

  constructor(
    private readonly db: Database,
    private readonly keys: VapidKeys,
    private readonly send: PushSender = webpush.sendNotification,
  ) {
    this.publicKey = keys.publicKey;
    for (const project of listProjects(db)) {
      for (const card of listCards(db, project.id)) {
        this.last.set(card.id, attentionOf(card));
        this.projectByCard.set(card.id, project.id);
      }
    }
  }

  async onEvent(event: DomainEvent): Promise<void> {
    if (event.t === "cardDeleted") {
      this.last.delete(event.id);
      this.projectByCard.delete(event.id);
      return;
    }
    if (event.t === "projectDeleted") {
      for (const [cardId, projectId] of this.projectByCard) {
        if (projectId === event.id) {
          this.projectByCard.delete(cardId);
          this.last.delete(cardId);
        }
      }
      return;
    }
    if (event.t !== "card") return;
    this.projectByCard.set(event.card.id, event.card.projectId);
    const attention = attentionOf(event.card);
    const previous = this.last.get(event.card.id) ?? null;
    this.last.set(event.card.id, attention);
    if (attention === null || attention === previous) return;

    const view = attention === "review-ready" ? "diff" : "board";
    const payload = JSON.stringify({
      title: event.card.title,
      body: label(attention),
      url: `/?project=${encodeURIComponent(event.card.projectId)}&view=${view}${view === "diff" ? `&card=${event.card.id}` : ""}`,
      tag: `rvmp-card-${event.card.id}`,
    });
    await Promise.all(listPushSubscriptions(this.db).map(async subscription => {
      try {
        await this.send(subscription, payload, {
          TTL: 24 * 3600,
          urgency: attention === "error" ? "high" : "normal",
          topic: `card-${event.card.id}`,
          vapidDetails: {
            subject: "mailto:rvmp@localhost",
            publicKey: this.keys.publicKey,
            privateKey: this.keys.privateKey,
          },
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) deletePushSubscription(this.db, subscription.endpoint);
        else console.warn(`[push] delivery failed: ${status ?? "network"}`);
      }
    }));
  }
}
