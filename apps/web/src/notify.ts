import type { Card, DomainEvent } from "@codegent/protocol";

// Lightweight in-tab notifications (local-only pivot: heavy Web Push with
// VAPID/service-worker was CUT; this fires from the live ws feed while the
// codegent tab is open). Content-minimal by principle 1: card TITLE (the
// user's own data) + a fixed state label — never terminal content.

export type Attention = "waiting" | "error" | "review-ready";

const KEY = "cgNotify";

export function notifyEnabled(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
}

/** Toggle; first enable asks for browser permission. Returns the ON state. */
export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    localStorage.setItem(KEY, "0");
    return false;
  }
  if (typeof Notification === "undefined") return false;
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  const granted = perm === "granted";
  localStorage.setItem(KEY, granted ? "1" : "0");
  return granted;
}

/** The three attention entries that notify (mirrors the push-kind trio). */
export function attentionOf(card: Card): Attention | null {
  if (card.phase === "working" && card.workingSub === "error") return "error";
  if (card.phase === "working" && card.inputKind !== null) return "waiting";
  if (card.phase === "review" && card.reviewSub === "ready") return "review-ready";
  return null;
}

export const attentionLabel = (a: Attention): string =>
  a === "waiting" ? "waiting for input" : a === "error" ? "error" : "ready for review";

/** Event-driven notifier with per-card+state dedupe (reconnect replays and
 * no-op updates never re-fire) and a visible-tab skip (the user is looking).
 * Deps are injectable for tests. */
export function createNotifier(deps?: {
  fire?: (title: string, body: string) => void;
  visible?: () => boolean;
  enabled?: () => boolean;
}) {
  const last = new Map<number, Attention | null>();
  const fire = deps?.fire ?? ((title: string, body: string) => {
    try {
      const n = new Notification(title, { body });
      n.onclick = () => window.focus();
    } catch { /* permission revoked mid-session — silently drop */ }
  });
  const visible = deps?.visible ?? (() => typeof document !== "undefined" && document.visibilityState === "visible");
  const enabled = deps?.enabled ?? notifyEnabled;

  return {
    onEvent(ev: DomainEvent): void {
      if (ev.t === "cardDeleted") {
        last.delete(ev.id);
        return;
      }
      if (ev.t !== "card") return;
      const attention = attentionOf(ev.card);
      const prev = last.get(ev.card.id) ?? null;
      last.set(ev.card.id, attention);
      if (attention === null || attention === prev) return; // ENTRY only, never repeats
      if (!enabled() || visible()) return;
      fire(ev.card.title, attentionLabel(attention));
    },
  };
}
