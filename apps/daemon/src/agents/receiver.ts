import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./common";
import { handleAgentApi, type AgentEngine } from "./mcp";

/** One normalized hook arrival. `event` is the agent CLI's raw hook JSON —
 * adapters (T7) normalize it into content-free signals; the receiver never
 * inspects it beyond the session-id fallback field. */
export interface HookDelivery {
  agent: string;
  sessionId: string | null;
  event: unknown;
}

export interface HookReceiver {
  port: number;
  token: string;
  endpointFile: string;
  /** The raw fetch handler — exposed for direct-invocation tests. */
  handle(req: Request): Promise<Response>;
  /** Adapters subscribe here (T7). A throwing subscriber is contained per-call. */
  onHook(cb: (h: HookDelivery) => void): () => void;
  stop(): void;
}

/** Orca-proven 1MB body cap (orca-agent-state §2.1) — second-line defense
 * behind loopback binding + token auth. */
export const HOOK_BODY_CAP = 1024 * 1024;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** `<dataDir>/agents` — signal-plane artifacts (endpoint file, hook script,
 * later T7's per-dispatch config dirs). Orca layout: dir 0700, files 0600. */
function agentsDir(dataDir: string): string {
  const dir = join(dataDir, "agents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Endpoint file (Orca restart-survival): a PTY that outlives a daemon restart
 * has stale port/token env baked in, so hook scripts source this file FIRST —
 * it always holds the CURRENT signal-plane endpoint. 0600, atomic tmp+rename.
 */
export function writeEndpointFile(dataDir: string, port: number, token: string): string {
  const file = join(agentsDir(dataDir), "endpoint.env");
  writeAtomic(file, `CODEGENT_HOOK_PORT=${port}\nCODEGENT_HOOK_TOKEN=${token}\n`, 0o600);
  return file;
}

/**
 * The /bin/sh forwarder agents register in their hook configs as
 * `hook.sh <agent>` — the CLI pipes its hook JSON to stdin, curl relays it.
 * Fail-open is the contract: 0.5s connect / 1.5s total curl budgets
 * (Orca-proven — keep exact), output discarded, and ALWAYS `exit 0`; a dead
 * daemon must never break or stall the agent's own hook execution.
 * Pane identity: `CODEGENT_SESSION_ID` (injected at spawn, per-pane) travels
 * as a request header; port/token come from the endpoint file with the
 * spawn-time env as fallback.
 */
export function writeHookScript(dataDir: string): string {
  const dir = agentsDir(dataDir);
  const path = join(dir, "hook.sh");
  const endpoint = join(dir, "endpoint.env");
  writeAtomic(path, `#!/bin/sh
# codegent hook forwarder — fail-open: never block or fail the agent.
# Endpoint file first (survives daemon restarts), spawn-time env as fallback.
[ -r "${endpoint}" ] && . "${endpoint}"
[ -n "$CODEGENT_HOOK_PORT" ] && [ -n "$CODEGENT_HOOK_TOKEN" ] || exit 0
curl -s --connect-timeout 0.5 --max-time 1.5 \\
  -H "x-codegent-hook-token: $CODEGENT_HOOK_TOKEN" \\
  -H "x-codegent-session-id: $CODEGENT_SESSION_ID" \\
  -H "content-type: application/json" \\
  -d @- "http://127.0.0.1:$CODEGENT_HOOK_PORT/hook/$1" >/dev/null 2>&1
exit 0
`, 0o755);
  return path;
}

/**
 * Loopback signal-plane server: hook ingestion (`POST /hook/:agent`) plus the
 * agent API the MCP sidecar calls (`/api/agent/*`). Binds 127.0.0.1 on a
 * random port with its own minted token — the UI-plane token from config.ts
 * never reaches agent processes, and this token never authorizes UI routes.
 */
export function startHookReceiver(deps: {
  dataDir: string;
  db: Database;
  /** Late-bound engine accessor (T8): the receiver boots before the engine —
   * which needs this receiver's port/token for its adapters — so the agent
   * routes fetch it per request. Absent (tests, boot window) → the complete
   * route degrades to the pre-engine marker-only behavior. */
  engine?: () => AgentEngine | undefined;
}): HookReceiver {
  const token = crypto.randomUUID().replace(/-/g, "");
  const subs = new Set<(h: HookDelivery) => void>();

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.headers.get("x-codegent-hook-token") !== token) return json({ error: "unauthorized" }, 401);
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > HOOK_BODY_CAP) return json({ error: "body too large" }, 413);

    // MCP sidecar plane — real errors are allowed here: they only ever surface
    // as tool errors inside the agent's own conversation (§6.1's sanctioned
    // echo), never in our UI.
    if (url.pathname.startsWith("/api/agent/")) {
      let body: unknown = {};
      if (raw.byteLength) {
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return json({ error: "invalid json" }, 400);
        }
      }
      try {
        return await handleAgentApi(req, url, body, deps.db, deps.engine?.());
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    // Hook plane — fail-open: past auth + cap, the agent-side script only ever
    // sees 200. Unparseable payloads are dropped, subscriber throws contained.
    const m = url.pathname.match(/^\/hook\/([^/]+)$/);
    if (!m || req.method !== "POST") return json({ error: "not found" }, 404);
    let event: unknown;
    let parsed = false;
    try {
      event = JSON.parse(new TextDecoder().decode(raw));
      parsed = true;
    } catch {}
    if (parsed) {
      // Pane identity: header primary (set by the hook script from its env);
      // a CODEGENT_SESSION_ID field inside the payload honored as fallback.
      const field = (event as Record<string, unknown> | null)?.CODEGENT_SESSION_ID;
      const sessionId =
        req.headers.get("x-codegent-session-id") || (typeof field === "string" ? field : null);
      const delivery: HookDelivery = { agent: m[1]!, sessionId: sessionId || null, event };
      for (const cb of subs) {
        try {
          cb(delivery);
        } catch {} // a bad subscriber must never fail the response or its peers
      }
    }
    return json({ ok: true });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1", // loopback ONLY — never exposed
    port: 0, // random port (Orca §2.1)
    idleTimeout: 5, // slowloris guard (Orca: 5s)
    maxRequestBodySize: 2 * HOOK_BODY_CAP, // hard stop above our own 413 line
    fetch: handle,
  });
  // `port` is only `undefined` for unix-socket servers — this is always TCP.
  const port = server.port!;
  const endpointFile = writeEndpointFile(deps.dataDir, port, token);

  return {
    port,
    token,
    endpointFile,
    handle,
    onHook(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    stop() {
      server.stop(true);
    },
  };
}
