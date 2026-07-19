import type { Database } from "bun:sqlite";
import { join, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { CardSchema, ProjectSchema, SessionMetaSchema, WorktreeSchema } from "@codegent/protocol";
import { createProject, listProjects } from "../store/projects";
import { createCard, updateCard, deleteCard, listCards } from "../store/cards";
import { createWorktree, listWorktrees, slug } from "../git/worktrees";
import type { PtyManager } from "../pty/manager";
import { events } from "../events";
import { wsHandlers, type WsData } from "./ws";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Body validation at the API boundary, derived from the protocol schemas: a
// value the protocol would reject must 400 here — otherwise it gets persisted,
// the emitted DomainEvent fails EnvelopeSchema in the ws fan-out, and every
// other tab silently desyncs.
const CardCreateBody = CardSchema.pick({ title: true, body: true, agent: true }).partial({ body: true, agent: true });
const CardPatchBody = CardSchema.pick({ title: true, body: true, phase: true, position: true, agent: true, worktreeId: true }).partial();
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

async function handleApi(req: Request, url: URL, db: Database, ptys: PtyManager): Promise<Response> {
  const body: any = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => ({})) : {};
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
    const v = CardCreateBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    const card = createCard(db, { projectId: x[1]!, title: v.data.title, body: v.data.body ?? "", agent: v.data.agent ?? "none" });
    events.emit({ t: "card", card });
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
  if ((x = m(/^\/api\/cards\/(\d+)$/)) && req.method === "DELETE") {
    deleteCard(db, Number(x[1]));
    events.emit({ t: "cardDeleted", id: Number(x[1]) });
    return json({ ok: true });
  }

  if ((x = m(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === "GET") return json(ptys.list(x[1]!));
  if ((x = m(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === "POST") {
    const v = SessionCreateBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    const project = listProjects(db).find(p => p.id === x![1]);
    const meta = ptys.open({
      projectId: x[1]!,
      cwd: v.data.cwd ?? project?.path ?? process.env.HOME ?? "/",
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

export function startServer(
  cfg: { port: number; dataDir: string; token: string },
  db: Database,
  ptys: PtyManager,
) {
  // apps/daemon/src/http → up 3 → apps, then web/dist
  const staticRoot = join(import.meta.dir, "../../../web/dist");

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
          return await handleApi(req, url, db, ptys);
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
