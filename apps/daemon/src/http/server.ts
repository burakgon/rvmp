import type { Database } from "bun:sqlite";
import { join, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { CardSchema, MarkStateBodySchema, ProjectSchema, SessionMetaSchema, WorktreeSchema } from "@codegent/protocol";
import { createProject, listProjects, setWorkerLimit } from "../store/projects";
import { createCard, updateCard, getCard, listCards } from "../store/cards";
import { listTimeline } from "../store/timeline";
import { createWorktree, getWorktree, listWorktrees, slug } from "../git/worktrees";
import { computeDiff, computeDiffSummary } from "../git/diff";
import { listReviewedFiles, setReviewed } from "../store/reviews";
import type { PtyManager } from "../pty/manager";
import { CardNotFound, MergeConflict, NotDeletable, NotStartable, NothingToUndo, PrUnavailable, UserActionError, type Engine, type MergeMode } from "../orchestrator/engine";
import { IllegalTransition } from "../orchestrator/machine";
import { events } from "../events";
import { wsHandlers, type WsData } from "./ws";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Body validation at the API boundary, derived from the protocol schemas: a
// value the protocol would reject must 400 here — otherwise it gets persisted,
// the emitted DomainEvent fails EnvelopeSchema in the ws fan-out, and every
// other tab silently desyncs.
const CardCreateBody = CardSchema.pick({ title: true, body: true, agent: true }).partial({ body: true, agent: true });
// Ordinary PATCH is content-only. Scheduling knobs use the queued-only routes
// below; position uses the project-scoped reorder route; lifecycle and
// worktree identity stay exclusively engine-written.
const CardPatchBody = CardSchema.pick({ title: true, body: true }).partial().strict();
const CardAutoBody = CardSchema.pick({ auto: true }).strict();
const CardAgentBody = CardSchema.pick({ agent: true }).strict();
const ProjectCreateBody = ProjectSchema.pick({ name: true, path: true, baseBranch: true }).partial({ baseBranch: true });
const SessionCreateBody = SessionMetaSchema.pick({ title: true, cwd: true, worktreeId: true }).partial();
const WorktreeCreateBody = WorktreeSchema.pick({ base: true }).partial();

const invalid = (e: { issues: { path: readonly PropertyKey[]; message: string }[] }) =>
  json({ error: e.issues.map(i => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") }, 400);

async function resolveBaseBranch(path: string): Promise<string> {
  const run = async (...args: string[]) => {
    const p = Bun.spawn({ cmd: ["git", ...args], cwd: path, stdout: "pipe", stderr: "pipe" });
    return (await p.exited) === 0 ? (await new Response(p.stdout).text()).trim() : null;
  };
  const head = await run("symbolic-ref", "refs/remotes/origin/HEAD", "--short"); // e.g. origin/main
  if (head) return head.replace(/^origin\//, "");
  // `||` not `??`: --show-current prints "" on a detached HEAD
  return (await run("branch", "--show-current")) || "main";
}

// Engine rejections → HTTP: unknown card 404; machine-illegal or unstartable
// (none-agent / adapterless) actions 409. Anything else rethrows into the 500
// handler. Error text is engine/git-authored — never terminal content.
const engineError = (e: unknown): Response => {
  if (e instanceof CardNotFound) return json({ error: e.message }, 404);
  if (e instanceof MergeConflict) return json({ error: e.message }, 409);
  if (e instanceof PrUnavailable) return json({ error: e.message, reason: e.reason }, 409);
  if (e instanceof UserActionError) return json({ error: e.message }, 409);
  if (e instanceof NotStartable) return json({ error: e.message }, 409);
  if (e instanceof NotDeletable) return json({ error: e.message }, 409);
  if (e instanceof NothingToUndo) return json({ error: e.message }, 409);
  if (e instanceof IllegalTransition) return json({ error: `illegal transition: ${e.message}` }, 409);
  throw e;
};

async function handleApi(req: Request, url: URL, db: Database, ptys: PtyManager, engine: Engine): Promise<Response> {
  // `?? {}` matters: a literal `null` body parses successfully and would
  // crash property probes into a 500 (review B1).
  const body: any =
    req.method === "POST" || req.method === "PATCH" || req.method === "PUT"
      ? (await req.json().catch(() => ({}))) ?? {}
      : {};
  const m = (re: RegExp) => url.pathname.match(re);
  let x: RegExpMatchArray | null;

  if (url.pathname === "/api/projects" && req.method === "GET") return json(listProjects(db));
  if (url.pathname === "/api/projects" && req.method === "POST") {
    const v = ProjectCreateBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    if (!existsSync(v.data.path)) return json({ error: "path does not exist" }, 400);
    if (!body.skipGitCheck) {
      const p = Bun.spawn({ cmd: ["git", "rev-parse", "--git-dir"], cwd: v.data.path, stdout: "pipe", stderr: "pipe" });
      if ((await p.exited) !== 0) return json({ error: "not a git repository" }, 400);
    }
    const baseBranch = v.data.baseBranch ?? (await resolveBaseBranch(v.data.path));
    const project = createProject(db, { name: v.data.name, path: v.data.path, baseBranch });
    events.emit({ t: "project", project });
    return json(project, 201);
  }

  if ((x = m(/^\/api\/projects\/([^/]+)\/cards$/)) && req.method === "GET") return json(listCards(db, x[1]!));
  if ((x = m(/^\/api\/projects\/([^/]+)\/cards$/)) && req.method === "POST") {
    // Existence pre-check before body validation, matching the worktrees route:
    // a ghost project is a 404, never a FK-violation 500.
    if (!listProjects(db).some(p => p.id === x![1])) return json({ error: "project not found" }, 404);
    const v = CardCreateBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    const card = createCard(db, { projectId: x[1]!, title: v.data.title, body: v.data.body ?? "", agent: v.data.agent ?? "none" });
    events.emit({ t: "card", card });
    engine.tick(); // R1: a new queued auto:on card may start immediately
    return json(card, 201);
  }
  if ((x = m(/^\/api\/cards\/(\d+)$/)) && req.method === "PATCH") {
    const v = CardPatchBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    let card;
    try {
      card = updateCard(db, Number(x[1]), v.data);
    } catch {
      return json({ error: "card not found" }, 404);
    }
    events.emit({ t: "card", card });
    return json(card);
  }

  // Queue policy is state-checked on dedicated surfaces: neither control can
  // retarget or reschedule an in-flight machine-owned task.
  if ((x = m(/^\/api\/cards\/(\d+)\/(auto|agent)$/)) && req.method === "PATCH") {
    const id = Number(x[1]);
    const card = getCard(db, id);
    if (!card) return json({ error: "card not found" }, 404);
    if (card.phase !== "queued") return json({ error: `${x[2]} can only be changed while queued` }, 409);
    const v = x[2] === "auto" ? CardAutoBody.safeParse(body) : CardAgentBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    const saved = updateCard(db, id, v.data);
    events.emit({ t: "card", card: saved });
    engine.tick();
    return json(saved);
  }

  // ---- v0.2 orchestrator action routes (T8) ----
  if ((x = m(/^\/api\/cards\/(\d+)\/(start|stop|merge|send-back|cancel|update)$/)) && req.method === "POST") {
    const id = Number(x[1]);
    const action = x[2]!;
    try {
      if (action === "start") await engine.start(id);
      else if (action === "stop") engine.stop(id);
      else if (action === "merge") {
        const mode = body.mode ?? "squash";
        if (mode !== "squash" && mode !== "merge" && mode !== "rebase") {
          return json({ error: "mode must be squash | merge | rebase" }, 400);
        }
        await engine.merge(id, mode as MergeMode);
      }
      else if (action === "cancel") await engine.cancel(id);
      else if (action === "update") await engine.update(id);
      else {
        const comments = body.comments ?? [];
        if (!Array.isArray(comments) || comments.some((c: unknown) => typeof c !== "string")) {
          return json({ error: "comments must be an array of strings" }, 400);
        }
        await engine.sendBack(id, comments);
      }
    } catch (e) {
      return engineError(e);
    }
    return json(getCard(db, id));
  }
  // §7.5 PR tracking — create (templated description) + manual merged fallback.
  if ((x = m(/^\/api\/cards\/(\d+)\/pr$/)) && req.method === "POST") {
    const id = Number(x[1]);
    try {
      await engine.prCreate(id);
    } catch (e) {
      return engineError(e);
    }
    return json(getCard(db, id), 201);
  }
  if ((x = m(/^\/api\/cards\/(\d+)\/pr\/mark-merged$/)) && req.method === "POST") {
    const id = Number(x[1]);
    try {
      await engine.markPrMerged(id);
    } catch (e) {
      return engineError(e);
    }
    return json(getCard(db, id));
  }
  // §7.3 grammar-bound escape hatch. Strict enum-only validation prevents a
  // route intended for state arbitration from accepting terminal content.
  if ((x = m(/^\/api\/cards\/(\d+)\/mark-state$/)) && req.method === "POST") {
    const v = MarkStateBodySchema.safeParse(body);
    if (!v.success) return invalid(v.error);
    const id = Number(x[1]);
    try {
      return json(await engine.markState(id, v.data.state));
    } catch (e) {
      return engineError(e);
    }
  }
  // ---- v0.2 recovery action routes (T9, spec §9.1 — one click, no dialogs;
  // error text is engine-authored, never terminal content) ----
  if ((x = m(/^\/api\/cards\/(\d+)\/(resume|restart|discard|undo-discard)$/)) && req.method === "POST") {
    const id = Number(x[1]);
    const action = x[2]!;
    try {
      if (action === "resume") await engine.resume(id);
      else if (action === "restart") await engine.restart(id);
      else if (action === "discard") return json({ card: await engine.discard(id), undo: true });
      else return json(engine.undoDiscard(id));
    } catch (e) {
      return engineError(e);
    }
    return json(getCard(db, id));
  }
  // Interrupted banner data (boot reconciliation §4.3): card ids ONLY — the
  // web renders its own fixed one-liner, no text crosses this surface.
  if (url.pathname === "/api/state/interrupted" && req.method === "GET") {
    const projectId = url.searchParams.get("project");
    if (!projectId) return json({ error: "project is required" }, 400);
    const cards = db.query(
      `SELECT id FROM cards
       WHERE project_id = ?1 AND phase = 'working' AND working_sub = 'error' AND error_kind = 'interrupted'
       ORDER BY id`,
    ).all(projectId).map((r: any) => r.id as number);
    return json({ cards });
  }
  // Timeline prose is deliberately pull-only and card-scoped: it never rides
  // the board event stream, so Details remains its sole rendering surface.
  if ((x = m(/^\/api\/cards\/(\d+)\/timeline$/)) && req.method === "GET") {
    const id = Number(x[1]);
    if (!getCard(db, id)) return json({ error: "card not found" }, 404);
    return json(listTimeline(db, id));
  }
  // §7.5 diff — computed on demand from the PROJECT repo (base...branch), so
  // it stays available for done cards whose worktree is already archived (the
  // branch ref survives). Diff content is repo data the user owns — never
  // terminal content.
  if ((x = m(/^\/api\/cards\/(\d+)\/diff$/)) && req.method === "GET") {
    const id = Number(x[1]);
    const card = getCard(db, id);
    if (!card) return json({ error: "card not found" }, 404);
    if (card.phase !== "review" && card.phase !== "done") {
      return json({ error: "diff is available in review or done" }, 409);
    }
    const wt = card.worktreeId ? getWorktree(db, card.worktreeId) : null;
    if (!wt) return json({ error: "card has no worktree" }, 409);
    const project = listProjects(db).find(p => p.id === card.projectId);
    if (!project) return json({ error: "project not found" }, 404);
    // Done cards: the branch ref was deliberately reset to the merge tip
    // (VK), so base...branch is empty — render the RECORDED merge commit
    // instead (review A7). External/empty merges have no local sha and fall
    // back to base...branch (external keeps its ref until the user prunes).
    const recorded = card.phase === "done" && card.mergeSha !== null && card.mergeSha.includes("..")
      ? card.mergeSha.split("..") as [string, string]
      : null;
    const [diffBase, diffHead] = recorded ?? [wt.base, wt.branch];
    try {
      if (url.searchParams.get("summary")) {
        return json(await computeDiffSummary(project.path, diffBase, diffHead));
      }
      return json(await computeDiff(project.path, diffBase, diffHead));
    } catch {
      // branch pruned past retention, repo moved, … — a stateful 409, not a 500
      return json({ error: "diff unavailable" }, 409);
    }
  }
  // Viewed-marks (§7.5 "n/m reviewed"). GET is phase-free (done view reads it);
  // PUT is review-only — marks are meaningless once the card leaves review.
  if ((x = m(/^\/api\/cards\/(\d+)\/reviewed-files$/))) {
    const id = Number(x[1]);
    const card = getCard(db, id);
    if (!card) return json({ error: "card not found" }, 404);
    if (req.method === "GET") return json({ paths: listReviewedFiles(db, id) });
    if (req.method === "PUT") {
      if (card.phase !== "review") return json({ error: "viewed marks are review-only" }, 409);
      if (typeof body.path !== "string" || body.path === "" || typeof body.viewed !== "boolean") {
        return json({ error: "path (non-empty string) and viewed (boolean) are required" }, 400);
      }
      setReviewed(db, id, body.path, body.viewed);
      return json({ paths: listReviewedFiles(db, id) });
    }
  }
  // Board reorder — queue ordering feeds R1's "topmost".
  if ((x = m(/^\/api\/projects\/([^/]+)\/cards\/(\d+)\/position$/)) && req.method === "PATCH") {
    const card = getCard(db, Number(x[2]));
    if (!card || card.projectId !== x[1]) return json({ error: "card not found" }, 404);
    if (typeof body.position !== "number" || !Number.isFinite(body.position)) {
      return json({ error: "position must be a number" }, 400);
    }
    const moved = updateCard(db, card.id, { position: body.position });
    events.emit({ t: "card", card: moved });
    engine.tick();
    return json(moved);
  }
  // Worker limit (spec §5 — Settings-owned, default 1).
  if ((x = m(/^\/api\/projects\/([^/]+)$/)) && req.method === "PATCH") {
    if (!listProjects(db).some(p => p.id === x![1])) return json({ error: "project not found" }, 404);
    if (!Number.isInteger(body.workerLimit) || body.workerLimit < 1) {
      return json({ error: "workerLimit must be an integer >= 1" }, 400);
    }
    const project = setWorkerLimit(db, x[1]!, body.workerLimit)!;
    events.emit({ t: "project", project });
    engine.tick(); // a raised limit can free slots right now
    return json(project);
  }
  if ((x = m(/^\/api\/cards\/(\d+)$/)) && req.method === "DELETE") {
    const id = Number(x[1]);
    try {
      await engine.delete(id);
    } catch (e) {
      return engineError(e);
    }
    return json({ ok: true });
  }

  if ((x = m(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === "GET") return json(ptys.list(x[1]!));
  if ((x = m(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === "POST") {
    const project = listProjects(db).find(p => p.id === x![1]);
    if (!project) return json({ error: "project not found" }, 404); // was: silent HOME fallback
    const v = SessionCreateBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    const meta = ptys.open({
      projectId: x[1]!,
      cwd: v.data.cwd ?? project.path,
      title: v.data.title ?? "shell",
      worktreeId: v.data.worktreeId ?? null,
    });
    return json(meta, 201);
  }
  if ((x = m(/^\/api\/sessions\/([^/]+)$/)) && req.method === "DELETE") {
    ptys.close(x[1]!);
    return json({ ok: true });
  }

  if ((x = m(/^\/api\/projects\/([^/]+)\/worktrees$/)) && req.method === "GET") return json(listWorktrees(db, x[1]!));
  if ((x = m(/^\/api\/projects\/([^/]+)\/worktrees$/)) && req.method === "POST") {
    const project = listProjects(db).find(p => p.id === x![1]);
    if (!project) return json({ error: "project not found" }, 404);
    const v = WorktreeCreateBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    // guard at the API boundary: a symbols-only name slugs to "" and would
    // otherwise surface as a raw `git worktree add` error
    if (!slug(String(body.name ?? ""))) return json({ error: "invalid name" }, 400);
    const wt = await createWorktree(db, project, { slugSource: body.name, base: v.data.base });
    return json(wt, 201);
  }

  return json({ error: "not found" }, 404);
}

/** Where the built web UI lives (§14 packaging): [1] explicit override,
 * [2] `share/web` beside the compiled binary (`dist/pkg/<t>/{bin,share}`),
 * [3] the dev monorepo path. First EXISTING wins; dev path is the fallback
 * even when absent so the error message stays actionable. */
export function resolveWebDist(execPath = process.execPath, dir = import.meta.dir): string {
  const override = process.env.CODEGENT_WEB_DIST;
  if (override) return override;
  const packaged = join(execPath, "..", "..", "share", "web");
  if (existsSync(packaged)) return packaged;
  return join(dir, "../../../web/dist"); // apps/daemon/src/http → apps, then web/dist
}

export function startServer(
  cfg: { port: number; dataDir: string; token: string },
  db: Database,
  ptys: PtyManager,
  engine: Engine,
) {
  const staticRoot = resolveWebDist();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    websocket: wsHandlers(ptys),
    async fetch(req, srv) {
      const url = new URL(req.url);
      const authed =
        url.searchParams.get("t") === cfg.token || req.headers.get("x-codegent-token") === cfg.token;

      if (url.pathname === "/ws") {
        if (!authed) return new Response("unauthorized", { status: 401 });
        const data: WsData = { subs: new Map() };
        return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        if (!authed) return json({ error: "unauthorized" }, 401);
        try {
          return await handleApi(req, url, db, ptys, engine);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      // static UI — no token needed; the app itself talks to /api with one
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = resolve(staticRoot, rel);
      if (filePath.startsWith(staticRoot + sep)) { // stay inside dist
        const st = statSync(filePath, { throwIfNoEntry: false });
        if (st?.isFile()) return new Response(Bun.file(filePath));
      }
      return json({ error: "ui not built — run bun run --cwd apps/web build, or use vite dev" }, 404);
    },
  });

  return { url: `http://127.0.0.1:${cfg.port}/`, stop: () => server.stop(true) };
}
