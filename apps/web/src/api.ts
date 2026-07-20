import { encodeEnvelope, decodeEnvelope, type DomainEvent } from "@codegent/protocol";
import { callCallbacks, nextDelay, Resubscriber } from "./wsCore";

// Chunked, not `String.fromCharCode(...b)`: the daemon's first `term` frame
// after `sub` is a full ring snapshot (up to 200KB), and spreading that many
// arguments overflows the call stack (engine/stack-depth dependent — well
// inside browser failure territory at snapshot size).
export const bytesToB64 = (b: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
};
export const b64ToBytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// Always same-origin: vite dev proxies /api and /ws to the daemon (see
// vite.config.ts); in prod the daemon serves the built UI itself. A hardcoded
// daemon origin would be a cross-origin fetch, and the daemon sends no CORS
// headers by design.
export const baseUrl = "";
export const token = () => (typeof localStorage !== "undefined" ? localStorage.getItem("cgToken") ?? "" : "");

const H = () => ({ "x-codegent-token": token(), "content-type": "application/json" });

// A failed response must throw, never silently no-op: the daemon reports
// errors as { error } json — surface that text, else "<status> <statusText>".
const check = async (res: Response): Promise<Response> => {
  if (res.ok) return res;
  let msg = "";
  try {
    const b: any = await res.json();
    if (typeof b?.error === "string") msg = b.error;
  } catch { /* non-json error body */ }
  throw new Error(msg || `${res.status} ${res.statusText}`);
};

export const api = {
  get: async <T>(p: string): Promise<T> => (await check(await fetch(baseUrl + p, { headers: H() }))).json(),
  post: async <T>(p: string, body: unknown): Promise<T> => (await check(await fetch(baseUrl + p, { method: "POST", headers: H(), body: JSON.stringify(body) }))).json(),
  patch: async <T>(p: string, body: unknown): Promise<T> => (await check(await fetch(baseUrl + p, { method: "PATCH", headers: H(), body: JSON.stringify(body) }))).json(),
  put: async <T>(p: string, body: unknown): Promise<T> => (await check(await fetch(baseUrl + p, { method: "PUT", headers: H(), body: JSON.stringify(body) }))).json(),
  del: async (p: string): Promise<void> => { await check(await fetch(baseUrl + p, { method: "DELETE", headers: H() })); },
};

// "connecting" only before the socket has ever been up; after any drop the
// state is "down" and STAYS "down" through retry attempts (an attempt is not
// progress) — that stability is what lets Shell's >1s strip timer work.
export type WsState = "open" | "connecting" | "down";

export type CgSocket = {
  readonly state: WsState;
  onState(cb: (s: WsState) => void): () => void;
  /** Fires after every re-open (never the first open), BEFORE the re-subs go
   * out — terminal panes sanitize themselves here, Shell refetches queries. */
  onReconnect(cb: () => void): () => void;
  sub(sid: string, onData: (bytes: Uint8Array) => void): () => void;
  input(sid: string, bytes: Uint8Array): void;
  resize(sid: string, cols: number, rows: number): void;
  close(): void;
};

export function connectWs(onEvent: (e: DomainEvent) => void): CgSocket {
  const core = new Resubscriber();
  const stateCbs = new Set<(s: WsState) => void>();
  const reconnectCbs = new Set<() => void>();
  let state: WsState = "connecting";
  let attempt = 0; // consecutive failures — reset on every successful open
  let everOpened = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket;

  const setState = (s: WsState) => {
    if (s === state) return;
    state = s;
    callCallbacks(stateCbs, s);
  };

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = (ws = new WebSocket(`${proto}://${location.host}/ws?t=${token()}`));
    // Every handler ignores events from a superseded socket (`sock !== ws`):
    // an old instance's late close must not flip state or schedule retries.
    sock.onopen = () => {
      if (sock !== ws) return;
      attempt = 0;
      const reopened = everOpened;
      everOpened = true;
      setState("open");
      // Order is the sanitize contract (docs/research/ghostty-web-spike.md):
      // reconnect callbacks run first so each pane clears its term, THEN subs
      // are re-sent from the map — the server answers every sub with the full
      // ring snapshot, which must land on a cleaned screen.
      const sids = core.sids();
      if (reopened) callCallbacks(reconnectCbs);
      sids.forEach(sid => sock.send(encodeEnvelope({ ch: "sub", sid })));
      core.drain().forEach(f => sock.send(f));
    };
    sock.onmessage = m => {
      const env = decodeEnvelope(String(m.data));
      if (env.ch === "event") onEvent(env.ev);
      else if (env.ch === "term") core.dispatch(env.sid, b64ToBytes(env.data));
    };
    sock.onclose = () => {
      if (sock !== ws || core.isClosed) return; // superseded, or explicit close()
      setState("down");
      retryTimer ??= setTimeout(() => {
        retryTimer = null;
        connect();
      }, nextDelay(attempt++));
    };
  };
  connect();

  const send = (frame: string, coalesceKey: string | null = null) => {
    // enqueue is a no-op once closed — v0.1 queued forever after close()
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    else core.enqueue(frame, coalesceKey);
  };

  return {
    get state() {
      return state;
    },
    onState(cb) {
      if (core.isClosed) return () => {};
      stateCbs.add(cb);
      return () => { stateCbs.delete(cb); };
    },
    onReconnect(cb) {
      if (core.isClosed) return () => {};
      reconnectCbs.add(cb);
      return () => { reconnectCbs.delete(cb); };
    },
    sub(sid, onData) {
      if (core.isClosed) return () => {};
      core.add(sid, onData);
      // Sub frames are never queued: every open re-sends them from the map.
      // Queueing one too would double-subscribe → double snapshot replay.
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeEnvelope({ ch: "sub", sid }));
      return () => {
        core.remove(sid);
        // No queue on the down path either: a fresh connection starts with
        // no server-side subs, so an unsub has nothing to undo there.
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeEnvelope({ ch: "unsub", sid }));
      };
    },
    input: (sid, bytes) => send(encodeEnvelope({ ch: "input", sid, data: bytesToB64(bytes) })),
    resize: (sid, cols, rows) => send(encodeEnvelope({ ch: "resize", sid, cols, rows }), `resize:${sid}`),
    close() {
      core.close(); // empties handlers + queue, blocks further sub/enqueue
      stateCbs.clear();
      reconnectCbs.clear();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      ws.close();
    },
  };
}
