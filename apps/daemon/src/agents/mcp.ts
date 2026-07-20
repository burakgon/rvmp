import type { Database } from "bun:sqlite";
import { appendTimeline } from "../store/timeline";
import { markPendingComplete, touchDispatchProgress } from "../store/attempts";

/** The engine surface the agent plane calls (structural — Engine satisfies
 * it; consumer-side so this module never imports the orchestrator). */
export interface AgentEngine {
  /** Session-key → current live dispatch id (T8 send-back aliasing). */
  resolveAgentDispatch(id: string): string;
  /** R3: dispatch latch → machine `complete` → R1 tick. */
  completeFromApi(dispatchId: string): void;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function getCard(db: Database, id: number): { id: number; title: string; body: string } | null {
  if (!Number.isInteger(id)) return null;
  return db.query(`SELECT id, title, body FROM cards WHERE id = ?1`).get(id) as any;
}

/** Dispatch lookup SCOPED TO THE CARD (`a.card_id = ?2`): a crossed envelope
 * (dispatch id paired with someone else's card id) 404s instead of gating,
 * heartbeating, or completing the wrong rows. */
function getDispatch(db: Database, id: string, cardId: number): { id: string; status: string; worktreePath: string | null } | null {
  const r = db.query(
    `SELECT d.id AS id, d.status AS status, w.path AS wt_path
     FROM dispatches d JOIN attempts a ON a.id = d.attempt_id
     LEFT JOIN worktrees w ON w.id = a.worktree_id
     WHERE d.id = ?1 AND a.card_id = ?2`,
  ).get(id, cardId) as any;
  return r ? { id: r.id, status: r.status, worktreePath: r.wt_path ?? null } : null;
}

/** `git status --porcelain` in the attached attempt worktree. Any spawn or git
 * failure rejects: completion is a fail-closed gate, never an inference that
 * an unreadable/non-repository path is clean. */
async function porcelain(cwd: string): Promise<string> {
  const p = Bun.spawn({ cmd: ["git", "status", "--porcelain"], cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(), // drain without echoing agent-hostile git text
  ]);
  if (code !== 0) throw new Error("git status failed");
  return out.replace(/\n$/, "");
}

/**
 * The agent-plane API consumed by the MCP sidecar (`mcp-entry.ts`), mounted on
 * the loopback hook receiver — sidecars authenticate with the signal-plane
 * token, and the daemon's UI token never crosses into agent processes. Unlike
 * the hook plane this surface returns real errors: they land in the agent's
 * own conversation as MCP tool errors, which is §6.1's single sanctioned echo
 * channel. Card-phase transitions happen ONLY through the engine hooks below;
 * nothing here emits domain events directly.
 *
 * Sidecar envelope ids are SPAWN-TIME ids; after a live-session send-back the
 * engine's alias map points them at the current dispatch, so every id is
 * resolved through `engine.resolveAgentDispatch` before any row is touched.
 */
export async function handleAgentApi(
  req: Request, url: URL, body: unknown, db: Database, engine?: AgentEngine,
): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const resolve = (id: string): string => engine?.resolveAgentDispatch(id) ?? id;

  if (url.pathname === "/api/agent/task" && req.method === "GET") {
    const card = getCard(db, Number(url.searchParams.get("card")));
    if (!card) return json({ error: "card not found" }, 404);
    const rawDispatch = url.searchParams.get("dispatch");
    if (!rawDispatch) return json({ error: "dispatch required" }, 400);
    const dispatch = getDispatch(db, resolve(rawDispatch), card.id);
    if (!dispatch) return json({ error: "dispatch not found" }, 404);
    // `acceptance` has no column yet — kept in the shape so the tool contract
    // (spec §6: title / description / acceptance notes) is stable when it lands.
    return json({ title: card.title, body: card.body, acceptance: null, dispatch: dispatch.id });
  }

  if (url.pathname === "/api/agent/progress" && req.method === "POST") {
    // Existence before body validation — same 404-before-400 precedence as the
    // project-scoped routes in http/server.ts.
    const card = getCard(db, Number(b.card));
    if (!card) return json({ error: "card not found" }, 404);
    if (typeof b.dispatch !== "string" || !b.dispatch) return json({ error: "dispatch required" }, 400);
    const dispatch = getDispatch(db, resolve(b.dispatch), card.id);
    if (!dispatch) return json({ error: "dispatch not found" }, 404); // unknown OR crossed envelope
    if (typeof b.note !== "string" || !b.note.trim()) return json({ error: "note required" }, 400);
    appendTimeline(db, card.id, "progress", b.note);
    touchDispatchProgress(db, dispatch.id, Date.now()); // the heartbeat the engine reads
    return json({ ok: true });
  }

  if (url.pathname === "/api/agent/complete" && req.method === "POST") {
    const card = getCard(db, Number(b.card));
    if (!card) return json({ error: "card not found" }, 404);
    const dispatch = typeof b.dispatch === "string" && b.dispatch
      ? getDispatch(db, resolve(b.dispatch), card.id)
      : null;
    if (!dispatch) return json({ error: "dispatch not found" }, 404); // unknown OR crossed envelope
    if (typeof b.summary !== "string") return json({ error: "summary required" }, 400);
    // Dirty-worktree gate (VK stop-gate, spec §6.1): the porcelain echoed here
    // reaches ONLY the agent's conversation via the sidecar's tool error — it
    // must never surface in our UI or on the event bus.
    if (!dispatch.worktreePath) return json({ error: "completion requires an attached worktree" }, 409);
    let status: string;
    try {
      status = await porcelain(dispatch.worktreePath);
    } catch {
      return json({ error: "worktree cleanliness could not be verified" }, 409);
    }
    if (status) return json({ error: `worktree has uncommitted changes:\n${status}` }, 409);
    // ORDERING (deliberate): [1] pending_complete marker — crash-safety: if
    // the daemon dies before the engine acts, the accepted completion survives
    // store-side for the next complete-eval / reconciliation to honor;
    // [2] summary → timeline `round` row (the sanctioned agent-authored text
    // location: Details drawer only); [3] engine completion. All three sit in
    // the same latch-guarded branch — a stale retry (marker returns false)
    // writes nothing, appends nothing, and never re-enters the engine.
    const recorded = markPendingComplete(db, dispatch.id);
    if (recorded) {
      appendTimeline(db, card.id, "round", b.summary);
      engine?.completeFromApi(dispatch.id);
    }
    return json(recorded ? { ok: true } : { ok: true, stale: true });
  }

  return json({ error: "not found" }, 404);
}
