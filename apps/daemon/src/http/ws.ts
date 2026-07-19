import type { ServerWebSocket } from "bun";
import { encodeEnvelope, decodeEnvelope, type DomainEvent } from "@codegent/protocol";
import type { PtyManager } from "../pty/manager";
import { events } from "../events";

export type WsData = { subs: Map<string, () => void> };

const sockets = new Set<ServerWebSocket<WsData>>();

// Process-wide fan-out: every DomainEvent goes to every connected socket.
// Each send is individually guarded so a dead/throwing socket can never
// propagate an exception back into the emitter (store writers, PtyManager).
events.on((e: DomainEvent) => {
  let msg: string;
  try {
    msg = encodeEnvelope({ ch: "event", ev: e });
  } catch (err) {
    console.warn("ws: dropped event failing schema", (err as Error).message);
    return; // malformed event must not break the bus either
  }
  for (const ws of sockets) {
    try {
      ws.send(msg);
    } catch {
      /* socket torn down mid-broadcast */
    }
  }
});

/**
 * Bun.serve websocket handlers. Protocol (Envelope):
 * client `sub {sid}` → one `term` frame with the full ring snapshot (base64),
 * then live output streamed as further `term` frames; `input`/`resize` are
 * forwarded to the PTY; `unsub` detaches. Socket close detaches everything.
 * `ws.data` is populated by `server.upgrade(req, { data })` in server.ts.
 */
export const wsHandlers = (ptys: PtyManager) => ({
  open(ws: ServerWebSocket<WsData>) {
    sockets.add(ws);
  },
  close(ws: ServerWebSocket<WsData>) {
    for (const off of ws.data.subs.values()) off();
    sockets.delete(ws);
  },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let env;
    try {
      env = decodeEnvelope(String(raw));
    } catch {
      return; // ignore malformed frames
    }
    try {
      if (env.ch === "sub") {
        if (ws.data.subs.has(env.sid)) return; // idempotent re-sub
        const s = ptys.get(env.sid);
        if (!s) return;
        const sid = env.sid;
        ws.send(encodeEnvelope({ ch: "term", sid, data: Buffer.from(s.snapshot()).toString("base64") }));
        const off = s.onData(b => {
          try {
            ws.send(encodeEnvelope({ ch: "term", sid, data: Buffer.from(b).toString("base64") }));
          } catch {
            /* never let a closed socket throw into the PTY data fan-out */
          }
        });
        ws.data.subs.set(sid, off);
      } else if (env.ch === "unsub") {
        ws.data.subs.get(env.sid)?.();
        ws.data.subs.delete(env.sid);
      } else if (env.ch === "input") {
        ptys.get(env.sid)?.write(Buffer.from(env.data, "base64"));
      } else if (env.ch === "resize") {
        ptys.get(env.sid)?.resize(env.cols, env.rows);
      }
    } catch {
      /* racing session teardown must not kill the socket */
    }
  },
});
