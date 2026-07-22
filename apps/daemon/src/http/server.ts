import type { Database } from "bun:sqlite";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { CardSchema, MarkStateBodySchema, ProjectSchema, SessionMetaSchema, WorktreeSchema } from "@rvmp/protocol";
import { createProject, listProjects, projectForPath, setWorkerLimit, updateProjectSettings } from "../store/projects";
import { createCard, updateCard, getCard, listCards } from "../store/cards";
import { listTimeline } from "../store/timeline";
import { archiveWorktree, createWorktree, getWorktree, listWorktrees, slug } from "../git/worktrees";
import { computeDiff, computeDiffSummary } from "../git/diff";
import { listReviewedFiles, setReviewed } from "../store/reviews";
import { listEventLog } from "../store/eventlog";
import type { PtyManager } from "../pty/manager";
import { CardNotFound, MergeConflict, NotDeletable, NotStartable, NothingToUndo, PrUnavailable, UserActionError, type Engine, type MergeMode } from "../orchestrator/engine";
import { AGENT_REGISTRY } from "../detect/agent-registry";
import { serviceStatus } from "../service";
import { IllegalTransition } from "../orchestrator/machine";
import { events } from "../events";
import { databaseIntegrity, ensureDailyBackup, listBackups } from "../store/db";
import { deletePushSubscription, listPushSubscriptions, loadVapidKeys, savePushSubscription } from "../push";
import { wsHandlers, type WsData } from "./ws";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Body validation at the API boundary, derived from the protocol schemas: a
// value the protocol would reject must 400 here — otherwise it gets persisted,
// the emitted DomainEvent fails EnvelopeSchema in the ws fan-out, and every
// other tab silently desyncs.
const CardCreateBody = CardSchema.pick({ title: true, body: true, agent: true, executionMode: true }).partial({ body: true, agent: true, executionMode: true });
// Ordinary PATCH is content-only. Scheduling knobs use the queued-only routes
// below; position uses the project-scoped reorder route; lifecycle and
// worktree identity stay exclusively engine-written.
const CardPatchBody = CardSchema.pick({ title: true, body: true }).partial().strict();
const CardAutoBody = CardSchema.pick({ auto: true }).strict();
const CardAgentBody = CardSchema.pick({ agent: true }).strict();
const CardModeBody = CardSchema.pick({ executionMode: true }).strict();
const ProjectCreateBody = ProjectSchema.pick({ name: true, path: true, baseBranch: true }).partial({ baseBranch: true });
const ProjectSettingsBody = ProjectSchema.pick({ name: true, baseBranch: true, defaultAgent: true, setupScript: true, copyGlobs: true, mode: true }).partial().strict();
const SessionCreateBody = SessionMetaSchema.pick({ title: true, cwd: true, worktreeId: true }).partial();
const WorktreeCreateBody = WorktreeSchema.pick({ base: true }).partial();

const invalid = (e: { issues: { path: readonly PropertyKey[]; message: string }[] }) =>
  json({ error: e.issues.map(i => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") }, 400);

/** The sheet advertises `~/code/...` — expand it server-side (review B-Min). */
function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

async function resolveBaseBranch(path: string): Promise<string> {
  const run = async (...args: string[]) => {
    const p = Bun.spawn({ cmd: ["git", ...args], cwd: path, stdout: "pipe", stderr: "pipe" });
    return (await p.exited) === 0 ? (await new Response(p.stdout).text()).trim() : null;
  };
  const head = await run("symbolic-ref", "refs/remotes/origin/HEAD", "--short"); // e.g. origin/main
  if (head) return head.replace(/^origin\//, "");
  const current = await run("branch", "--show-current"); // "" on detached HEAD
  if (current) return current;
  // Detached HEAD: fall back to the repo's FIRST local branch, not a blind
  // "main" that may not exist (review A-Imp: worktree creation would fail).
  const first = await run("for-each-ref", "--format=%(refname:short)", "--count=1", "refs/heads");
  return first || "main";
}

/** §8 daemon-side path autocomplete: HOME-anchored only (a remote browser
 * must never browse the host filesystem at large), directories only, cap 20.
 * Pure for tests. */
export function pathComplete(q: string, home = homedir()): string[] {
  const expanded = q === "" || q === "~" ? home + sep
    : q.startsWith("~/") ? join(home, q.slice(2))
    : q;
  // Canonical containment (review A-Imp): boundary-aware (home + sep, so
  // /Users/alice-private never passes for /Users/alice) and symlink-resolved
  // (a link inside home pointing at /etc must not be enumerable).
  const inHome = (path: string): boolean => {
    const r = resolve(path);
    if (r !== home && !r.startsWith(home + sep)) return false;
    try {
      // Compare REAL to REAL: home itself may sit behind a symlink
      // (macOS /var → /private/var), so mixing real and lexical paths
      // would reject legitimate home children.
      const real = realpathSync(r);
      const realHome = realpathSync(home);
      return real === realHome || real.startsWith(realHome + sep);
    } catch {
      return false;
    }
  };
  if (!inHome(expanded) && !inHome(resolve(expanded, ".."))) return [];
  const endsWithSep = expanded.endsWith(sep);
  const parent = endsWithSep ? expanded.slice(0, -1) || sep : resolve(expanded, "..");
  const prefix = endsWithSep ? "" : expanded.slice(parent.length).replace(/^\//, "");
  if (!existsSync(parent) || !statSync(parent).isDirectory() || !inHome(parent)) return [];
  const out: string[] = [];
  for (const name of readdirSync(parent)) {
    if (name.startsWith(".") && !prefix.startsWith(".")) continue;
    if (!name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const full = join(parent, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch { continue; }
    out.push(full);
    if (out.length >= 20) break;
  }
  return out.sort();
}

export type DirectorySnapshot = {
  home: string;
  current: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  repository: null | { root: string; branch: string | null; isRoot: boolean };
};

/** Remote-safe directory browser. The browser receives directory metadata,
 * never arbitrary file contents, and symlinks cannot escape the daemon home. */
export function browseDirectories(input = "", showHidden = false, home = homedir()): DirectorySnapshot | null {
  const requested = input === "" ? home : expandHome(input, home);
  if (!existsSync(requested)) return null;
  let current: string;
  let realHome: string;
  try {
    current = realpathSync(requested);
    realHome = realpathSync(home);
    if (!statSync(current).isDirectory()) return null;
  } catch {
    return null;
  }
  if (current !== realHome && !current.startsWith(realHome + sep)) return null;
  const entries: DirectorySnapshot["entries"] = [];
  try {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!showHidden && entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      try {
        const real = realpathSync(path);
        if (real !== realHome && !real.startsWith(realHome + sep)) continue;
        if (!statSync(real).isDirectory()) continue;
        entries.push({ name: entry.name, path });
      } catch { /* unreadable/broken entries are not selectable */ }
    }
  } catch {
    return null;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const top = Bun.spawnSync({ cmd: ["git", "-C", current, "rev-parse", "--show-toplevel"], stdout: "pipe", stderr: "ignore" });
  let repository: DirectorySnapshot["repository"] = null;
  if (top.exitCode === 0) {
    const root = realpathSync(top.stdout.toString().trim());
    const branchResult = Bun.spawnSync({ cmd: ["git", "-C", current, "branch", "--show-current"], stdout: "pipe", stderr: "ignore" });
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.toString().trim() || null : null;
    repository = { root, branch, isRoot: root === current };
  }
  return {
    home: realHome,
    current,
    parent: current === realHome ? null : dirname(current),
    entries,
    repository,
  };
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

async function handleApi(req: Request, url: URL, db: Database, ptys: PtyManager, engine: Engine, dataDir: string): Promise<Response> {
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
    let projectPath = expandHome(v.data.path);
    // §8 "git clone URL" tab: path is the DESTINATION (created by the clone).
    if (typeof body.clone === "string" && body.clone) {
      if (body.clone.startsWith("-")) return json({ error: "invalid clone URL" }, 400); // option smuggling (A-Imp)
      if (existsSync(projectPath)) return json({ error: "clone destination already exists" }, 400);
      const c = Bun.spawn({ cmd: ["git", "clone", "--", body.clone, projectPath], stdout: "pipe", stderr: "pipe" });
      if ((await c.exited) !== 0) return json({ error: "git clone failed" }, 400);
    }
    if (!existsSync(projectPath)) return json({ error: "path does not exist" }, 400);
    const pathKey = realpathSync(projectPath);
    const existing = body.skipGitCheck ? null : projectForPath(db, projectPath, pathKey);
    if (existing) return json({ error: `project path is already registered as '${existing.name}'`, projectId: existing.id }, 409);
    if (!body.skipGitCheck) {
      const p = Bun.spawn({ cmd: ["git", "rev-parse", "--git-dir"], cwd: projectPath, stdout: "pipe", stderr: "pipe" });
      if ((await p.exited) !== 0) {
        // §8 non-git folder → refuse with one-click "git init" (the sheet
        // resubmits with gitInit:true).
        if (body.gitInit === true) {
          const g = Bun.spawn({ cmd: ["git", "init", "-b", "main"], cwd: projectPath, stdout: "pipe", stderr: "pipe" });
          if ((await g.exited) !== 0) return json({ error: "git init failed" }, 400);
        } else {
          return json({ error: "not a git repository", canInit: true }, 400);
        }
      }
    }
    const baseBranch = v.data.baseBranch ?? (await resolveBaseBranch(projectPath));
    // Validate settings BEFORE any insert (verify NOT-CLOSED: invalid
    // settings must 400, never a silently default-configured 201) — then
    // insert+apply as ONE transaction.
    const settings = ProjectSettingsBody.safeParse(body.settings ?? {});
    if (!settings.success) return invalid(settings.error);
    const project = db.transaction(() => {
      let created = createProject(db, { name: v.data.name, path: projectPath, pathKey: body.skipGitCheck ? undefined : pathKey, baseBranch });
      if (Object.keys(settings.data).length > 0) {
        created = updateProjectSettings(db, created.id, settings.data) ?? created;
      }
      return created;
    })();
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
    const card = createCard(db, { projectId: x[1]!, title: v.data.title, body: v.data.body ?? "", agent: v.data.agent ?? "none", executionMode: v.data.executionMode ?? "inherit" });
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
  if ((x = m(/^\/api\/cards\/(\d+)\/(auto|agent|mode)$/)) && req.method === "PATCH") {
    const id = Number(x[1]);
    const card = getCard(db, id);
    if (!card) return json({ error: "card not found" }, 404);
    if (card.phase !== "queued") return json({ error: `${x[2]} can only be changed while queued` }, 409);
    const v = x[2] === "auto" ? CardAutoBody.safeParse(body)
      : x[2] === "agent" ? CardAgentBody.safeParse(body)
      : CardModeBody.safeParse(body);
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
  // §8 project settings (Part 4) — strict enum/string surface, engine-read.
  if ((x = m(/^\/api\/projects\/([^/]+)\/settings$/)) && req.method === "PATCH") {
    const v = ProjectSettingsBody.safeParse(body);
    if (!v.success) return invalid(v.error);
    const project = updateProjectSettings(db, x[1]!, v.data);
    if (!project) return json({ error: "project not found" }, 404);
    events.emit({ t: "project", project });
    return json(project);
  }
  // §8 add-project sheet: daemon-side dir autocomplete (browser may be remote).
  if (url.pathname === "/api/state/path-complete" && req.method === "GET") {
    return json({ paths: pathComplete(url.searchParams.get("q") ?? "") });
  }
  if (url.pathname === "/api/state/directories" && req.method === "GET") {
    const snapshot = browseDirectories(
      url.searchParams.get("path") ?? "",
      url.searchParams.get("hidden") === "1",
    );
    return snapshot ? json(snapshot) : json({ error: "directory is unavailable or outside the allowed home" }, 400);
  }
  // §8 first-run agent probe rows + Settings agent versions (60s cache).
  if (url.pathname === "/api/state/agents" && req.method === "GET") {
    if (url.searchParams.get("refresh") === "1") agentProbeCache = null;
    return json({ agents: await probeAgents() });
  }
  if (url.pathname === "/api/state/project-summaries" && req.method === "GET") {
    const rows = db.query(
      `SELECT p.id,
        SUM(CASE WHEN c.phase = 'working' AND c.working_sub IN ('starting','running') AND c.input_kind IS NULL THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN c.phase = 'working' AND c.input_kind IS NOT NULL THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN c.phase = 'working' AND c.working_sub = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN c.phase = 'review' THEN 1 ELSE 0 END) AS review
       FROM projects p LEFT JOIN cards c ON c.project_id = p.id GROUP BY p.id`,
    ).all() as Array<{ id: string; running: number; waiting: number; errors: number; review: number }>;
    return json(rows);
  }
  // §8 Settings: user-service state (launchd/systemd).
  if (url.pathname === "/api/state/service" && req.method === "GET") {
    return json({ status: await serviceStatus() });
  }
  if (url.pathname === "/api/state/database" && req.method === "GET") {
    const dbPath = join(dataDir, "db.sqlite");
    return json({ integrity: databaseIntegrity(db), backups: listBackups(dbPath) });
  }
  if (url.pathname === "/api/state/database/backup" && req.method === "POST") {
    const dbPath = join(dataDir, "db.sqlite");
    const path = ensureDailyBackup(db, dbPath, new Date(), true);
    return json({ name: path.split(sep).pop(), backups: listBackups(dbPath) }, 201);
  }
  if (url.pathname === "/api/state/push" && req.method === "GET") {
    return json({ publicKey: loadVapidKeys(dataDir).publicKey, subscriptions: listPushSubscriptions(db).length });
  }
  if (url.pathname === "/api/state/push/subscriptions" && req.method === "POST") {
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    let endpointUrl: URL;
    try { endpointUrl = new URL(endpoint); } catch { return json({ error: "invalid push subscription endpoint" }, 400); }
    if (endpointUrl.protocol !== "https:" || endpoint.length > 4096
      || typeof p256dh !== "string" || !p256dh || p256dh.length > 512
      || typeof auth !== "string" || !auth || auth.length > 512) {
      return json({ error: "invalid push subscription" }, 400);
    }
    savePushSubscription(db, { endpoint, expirationTime: null, keys: { p256dh, auth } });
    return json({ ok: true }, 201);
  }
  if (url.pathname === "/api/state/push/subscriptions" && req.method === "DELETE") {
    const endpoint = url.searchParams.get("endpoint");
    if (!endpoint) return json({ error: "endpoint is required" }, 400);
    deletePushSubscription(db, endpoint);
    return json({ ok: true });
  }
  // §8 event log — project-scoped, card-filterable, capped.
  if ((x = m(/^\/api\/projects\/([^/]+)\/events$/)) && req.method === "GET") {
    if (!listProjects(db).some(p => p.id === x![1])) return json({ error: "project not found" }, 404);
    const cardParam = url.searchParams.get("card");
    const rawLimit = Number(url.searchParams.get("limit"));
    const rawCard = cardParam ? Number(cardParam) : undefined;
    return json(listEventLog(db, x[1]!, {
      cardId: Number.isInteger(rawCard) ? rawCard : undefined,
      limit: Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
    }));
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
  if ((x = m(/^\/api\/projects\/([^/]+)$/)) && req.method === "DELETE") {
    try {
      await engine.detachProject(x[1]!);
    } catch (e) {
      return engineError(e);
    }
    return json({ ok: true });
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
    if (!ptys.close(x[1]!)) return json({ error: "live session not found" }, 404);
    return json({ ok: true });
  }
  if ((x = m(/^\/api\/sessions\/([^/]+)$/)) && req.method === "PATCH") {
    if (typeof body.title !== "string" || !body.title.trim() || Object.keys(body).some(key => key !== "title")) {
      return json({ error: "title must be a non-empty string" }, 400);
    }
    const session = ptys.rename(x[1]!, body.title.trim());
    return session ? json(session) : json({ error: "session not found" }, 404);
  }

  if ((x = m(/^\/api\/projects\/([^/]+)\/worktrees$/)) && req.method === "GET") {
    const rows = listWorktrees(db, x[1]!);
    if (!url.searchParams.get("sizes")) return json(rows);
    // §8 disk management: du per ACTIVE worktree (archived dirs are gone).
    const sized = await Promise.all(rows.map(async (w) => ({
      ...w,
      bytes: w.state === "active" && existsSync(w.path) ? await dirBytes(w.path) : 0,
      cardId: (db.query(`SELECT id FROM cards WHERE worktree_id = ?1 LIMIT 1`).get(w.id) as { id: number } | null)?.id ?? null,
    })));
    return json(sized);
  }
  // §8 archive management: prune archived rows + their kept branches.
  // DESTRUCTIVE (the 14-day branch retention ends here) — the UI confirms.
  if ((x = m(/^\/api\/projects\/([^/]+)\/worktrees\/archived$/)) && req.method === "DELETE") {
    const project = listProjects(db).find(p => p.id === x![1]);
    if (!project) return json({ error: "project not found" }, 404);
    const archived = listWorktrees(db, project.id).filter(w => w.state === "archived");
    for (const w of archived) {
      const b = Bun.spawn({ cmd: ["git", "branch", "-D", w.branch], cwd: project.path, stdout: "pipe", stderr: "pipe" });
      await b.exited; // best-effort: an already-gone branch is fine
      db.query(`DELETE FROM worktrees WHERE id = ?1`).run(w.id);
    }
    return json({ pruned: archived.length });
  }
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
  if ((x = m(/^\/api\/worktrees\/([^/]+)\/archive$/)) && req.method === "POST") {
    const worktree = getWorktree(db, x[1]!);
    if (!worktree) return json({ error: "worktree not found" }, 404);
    if (worktree.state !== "active") return json({ error: "worktree is already archived" }, 409);
    const owner = db.query(`SELECT id FROM cards WHERE worktree_id = ?1 LIMIT 1`).get(worktree.id) as { id: number } | null;
    if (owner) return json({ error: `worktree belongs to card ${owner.id} and must be managed from that card` }, 409);
    const project = listProjects(db).find(value => value.id === worktree.projectId);
    if (!project) return json({ error: "project not found" }, 404);
    await archiveWorktree(db, project, worktree.id);
    return json(getWorktree(db, worktree.id));
  }
  if ((x = m(/^\/api\/worktrees\/([^/]+)$/)) && req.method === "DELETE") {
    const worktree = getWorktree(db, x[1]!);
    if (!worktree) return json({ error: "worktree not found" }, 404);
    if (worktree.state !== "archived") return json({ error: "archive the worktree before pruning it" }, 409);
    const project = listProjects(db).find(value => value.id === worktree.projectId);
    if (project) {
      const branch = Bun.spawn({ cmd: ["git", "branch", "-D", worktree.branch], cwd: project.path, stdout: "pipe", stderr: "pipe" });
      await branch.exited;
    }
    db.query(`DELETE FROM worktrees WHERE id = ?1`).run(worktree.id);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

/** du -sk equivalent without shelling per-file: fast enough for a handful of
 * worktrees; recursion is bounded by the worktree itself. */
async function dirBytes(path: string): Promise<number> {
  const p = Bun.spawn({ cmd: ["du", "-sk", path], stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  if (code !== 0) return 0;
  return (Number.parseInt(out.trim().split(/\s+/)[0] ?? "0", 10) || 0) * 1024;
}

/** §8 agent probe: which + `--version` first line per registry agent (the
 * pseudo-agent `generic` excluded). 60s cache — Settings polls freely. */
let agentProbeCache: { at: number; rows: Array<{ name: string; path: string | null; version: string | null }> } | null = null;
async function probeAgents(): Promise<Array<{ name: string; path: string | null; version: string | null }>> {
  if (agentProbeCache && Date.now() - agentProbeCache.at < 60_000) return agentProbeCache.rows;
  const rows = await Promise.all(AGENT_REGISTRY.filter(a => a.name !== "generic").map(async (agent) => {
    const path = agent.binaries.map(b => Bun.which(b)).find((p): p is string => p !== null) ?? null;
    let version: string | null = null;
    if (path) {
      try {
        const p = Bun.spawn({ cmd: [path, "--version"], stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => p.kill(), 1_500);
        const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
        clearTimeout(timer);
        if (code === 0) version = out.trim().split("\n")[0]?.slice(0, 60) ?? null;
      } catch { /* version probe is cosmetic */ }
    }
    return { name: agent.name, path, version };
  }));
  agentProbeCache = { at: Date.now(), rows };
  return rows;
}

/** Where the built web UI lives (§14 packaging): [1] explicit override,
 * [2] `share/web` beside the compiled binary (`dist/pkg/<t>/{bin,share}`),
 * [3] the dev monorepo path. First EXISTING wins; dev path is the fallback
 * even when absent so the error message stays actionable. */
export function resolveWebDist(execPath = process.execPath, dir = import.meta.dir): string {
  const override = process.env.RVMP_WEB_DIST;
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
        url.searchParams.get("t") === cfg.token || req.headers.get("x-rvmp-token") === cfg.token;

      if (url.pathname === "/ws") {
        if (!authed) return new Response("unauthorized", { status: 401 });
        const data: WsData = { subs: new Map() };
        return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        if (!authed) return json({ error: "unauthorized" }, 401);
        try {
          return await handleApi(req, url, db, ptys, engine, cfg.dataDir);
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
