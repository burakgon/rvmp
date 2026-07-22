import type { Card, DomainEvent } from "@rvmp/protocol";
import { api } from "./api";

// Web Push is the primary path: the daemon can notify while every rvmp tab is
// closed. Browsers without PushManager retain the event-driven in-tab fallback.
// Payloads stay content-minimal: card title + fixed state, never PTY content.

export type Attention = "waiting" | "error" | "review-ready";

const KEY = "cgNotify";
const PUSH_KEY = "cgNotifyPush";
const CHANGE_EVENT = "rvmp-notify-change";

export function notifyEnabled(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
}

export function notifyUsesPush(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(PUSH_KEY) === "1";
}

export function onNotifyChange(callback: (enabled: boolean) => void): () => void {
  const listener = () => callback(notifyEnabled());
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

const storeState = (enabled: boolean, push: boolean): void => {
  localStorage.setItem(KEY, enabled ? "1" : "0");
  localStorage.setItem(PUSH_KEY, push ? "1" : "0");
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

const applicationServerKey = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
};

/** Toggle; first enable asks for browser permission. Returns the ON state. */
export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await api.del(`/api/state/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`).catch(() => {});
          await subscription.unsubscribe();
        }
      } catch { /* revoked service-worker access must not leave the UI enabled */ }
    }
    storeState(false, false);
    return false;
  }
  if (typeof Notification === "undefined") return false;
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  const granted = perm === "granted";
  if (!granted) {
    storeState(false, false);
    return false;
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    storeState(true, false);
    return true;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const state = await api.get<{ publicKey: string }>("/api/state/push");
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(state.publicKey),
    });
    await api.post("/api/state/push/subscriptions", subscription.toJSON());
    storeState(true, true);
  } catch {
    // Private mode and non-secure remote origins can reject PushManager even
    // after permission; retain the live-tab Notification fallback.
    storeState(true, false);
  }
  return true;
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
  const enabled = deps?.enabled ?? (() => notifyEnabled() && !notifyUsesPush());

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
