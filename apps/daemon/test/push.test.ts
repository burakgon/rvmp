import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCard, updateCard } from "../src/store/cards";
import { openDb } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { deletePushSubscription, listPushSubscriptions, loadVapidKeys, PushNotifier, savePushSubscription, type PushSender } from "../src/push";

const dir = mkdtempSync(join(tmpdir(), "rvmp-push-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("VAPID identity persists mode-0600 and subscriptions round-trip", () => {
  const first = loadVapidKeys(dir);
  const second = loadVapidKeys(dir);
  expect(second).toEqual(first);
  expect(statSync(join(dir, "push-keys.json")).mode & 0o777).toBe(0o600);

  const db = openDb(":memory:");
  savePushSubscription(db, { endpoint: "https://push.example/one", keys: { p256dh: "public", auth: "secret" } });
  expect(listPushSubscriptions(db)).toHaveLength(1);
  expect(deletePushSubscription(db, "https://push.example/one")).toBe(true);
  expect(listPushSubscriptions(db)).toHaveLength(0);
  db.close();
});

test("push notifier emits on attention entry only and removes expired subscriptions", async () => {
  const db = openDb(":memory:");
  const project = createProject(db, { name: "P", path: "/tmp/p", baseBranch: "main" });
  const card = createCard(db, { projectId: project.id, title: "Review this", body: "", agent: "codex" });
  savePushSubscription(db, { endpoint: "https://push.example/expired", keys: { p256dh: "public", auth: "secret" } });
  const payloads: string[] = [];
  const sender = (async (_subscription: Parameters<PushSender>[0], payload: Parameters<PushSender>[1]) => {
    payloads.push(String(payload));
    if (payloads.length === 2) throw Object.assign(new Error("gone"), { statusCode: 410 });
    return {} as never;
  }) as PushSender;
  const notifier = new PushNotifier(db, loadVapidKeys(dir), sender);

  const waiting = updateCard(db, card.id, { phase: "working", workingSub: "running", inputKind: "question" });
  await notifier.onEvent({ t: "card", card: waiting });
  await notifier.onEvent({ t: "card", card: waiting });
  expect(payloads).toHaveLength(1);

  const clear = updateCard(db, card.id, { inputKind: null });
  await notifier.onEvent({ t: "card", card: clear });
  const failed = updateCard(db, card.id, { workingSub: "error", errorKind: "crashed" });
  await notifier.onEvent({ t: "card", card: failed });
  expect(payloads).toHaveLength(2);
  expect(listPushSubscriptions(db)).toHaveLength(0);
  db.close();
});
