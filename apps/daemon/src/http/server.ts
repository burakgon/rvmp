import type { Database } from "bun:sqlite";
import { join, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createProject, listProjects } from "../store/projects";
import { createCard, updateCard, deleteCard, listCards } from "../store/cards";
import { createWorktree, listWorktrees, slug } from "../git/worktrees";
import type { PtyManager } from "../pty/manager";
import { events } from "../events";
import { wsHandlers, type WsData } from "./ws";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

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
    if (!body.name || !body.path) return json({ error: "name and path required" }, 400);
    if (!existsSync(body.path)) return json({ error: "path does not exist" }, 400);
    if (!body.skipGitCheck) {
      const p = Bun.spawn({ cmd: ["git", "rev-parse", "--git-dir"], cwd: body.path, stdout: "pipe", stderr: "pipe" });
      if ((await p.exited) !== 0) return json({ error: "not a git repository" }, 400);
    }
    const baseBranch = body.baseBranch ?? (await resolveBaseBranch(body.path));
    const project = createProject(db, { name: body.name, path: body.path, baseBranch });
    events.emit({ t: "project", project });
    return json(project, 201);
  }

  if ((x = m(/^\/api\/projects\/([^/]+)\/cards$/)) && req.method === "GET") return json(listCards(db, x[1]!));
  if ((x = m(/^\/api\/projects\/([^/]+)\/cards$/)) && req.method === "POST") {
    if (!body.title) return json({ error: "title required" }, 400);
    const card = createCard(db, { projectId: x[1]!, title: body.title, body: body.body ?? "", agent: body.agent ?? "none" });
    events.emit({ t: "card", card });
    return json(card, 201);
  }
  if ((x = m(/^\/api\/cards\/(\d+)$/)) && req.method === "PATCH") {
    let card;
    try {
      card = updateCard(db, Number(x[1]), body);
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
    const project = listProjects(db).find(p => p.id === x![1]);
    const meta = ptys.open({
      projectId: x[1]!,
      cwd: body.cwd ?? project?.path ?? process.env.HOME ?? "/",
      title: body.title ?? "shell",
      worktreeId: body.worktreeId ?? null,
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
    // guard at the API boundary: a symbols-only name slugs to "" and would
    // otherwise surface as a raw `git worktree add` error
    if (!slug(String(body.name ?? ""))) return json({ error: "invalid name" }, 400);
    const wt = await createWorktree(db, project, { slugSource: body.name, base: body.base });
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
