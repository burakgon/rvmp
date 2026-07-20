import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { createCard, updateCard, listCards } from "../src/store/cards";
import { createAttempt, createDispatch, completeDispatch, pendingComplete } from "../src/store/attempts";
import { listTimeline } from "../src/store/timeline";
import { startHookReceiver } from "../src/agents/receiver";
import { events } from "../src/events";
import type { Card, DomainEvent, Project } from "@codegent/protocol";

const ENTRY = join(import.meta.dir, "../src/agents/mcp-entry.ts");

const sh = async (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
};

/** Minimal newline-delimited JSON-RPC client over a spawned sidecar's stdio —
 * hand-rolled on purpose: it pins the MCP wire format independently of the SDK
 * client (an SDK bug would otherwise pass a same-SDK roundtrip both ways). */
function spawnSidecar(env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY],
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", ...env },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;
  (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      }
    }
  })();
  const send = (m: unknown) => {
    proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.flush();
  };
  return {
    request(method: string, params?: unknown): Promise<any> {
      const id = nextId++;
      const p = new Promise<any>((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => reject(new Error(`rpc timeout on ${method}`)), 10_000);
      });
      send({ jsonrpc: "2.0", id, method, params });
      return p;
    },
    notify(method: string, params?: unknown): void {
      send({ jsonrpc: "2.0", method, params });
    },
    async stop(): Promise<void> {
      proc.kill();
      await proc.exited;
    },
  };
}

type Sidecar = ReturnType<typeof spawnSidecar>;

async function handshake(c: Sidecar): Promise<any> {
  const init = await c.request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cg-test", version: "0" },
  });
  c.notify("notifications/initialized");
  return init.result;
}

const db = openDb(":memory:");
const dataDir = mkdtempSync(join(tmpdir(), "cg-mcp-"));
const rx = startHookReceiver({ dataDir, db });
const api = `http://127.0.0.1:${rx.port}/api/agent`;
const H = { headers: { "x-codegent-hook-token": rx.token, "content-type": "application/json" } };

let project: Project;
let cardClean: Card, cardDirty: Card;
let dispatchClean: string, dispatchDirty: string;
let cardNoWorktree: Card, cardNonRepo: Card, cardUnreadable: Card;
let dispatchNoWorktree: string, dispatchNonRepo: string, dispatchUnreadable: string;
let attemptCleanId: number;
let cleanRepo: string, dirtyRepo: string, nonRepoDir: string, unreadableDir: string;
let sidecar: Sidecar; // bound to the clean card/dispatch
const domainEvents: DomainEvent[] = [];
let offEvents: () => void;

beforeAll(async () => {
  offEvents = events.on(e => domainEvents.push(e));

  cleanRepo = mkdtempSync(join(tmpdir(), "cg-wt-clean-"));
  dirtyRepo = mkdtempSync(join(tmpdir(), "cg-wt-dirty-"));
  nonRepoDir = mkdtempSync(join(tmpdir(), "cg-wt-nonrepo-"));
  unreadableDir = mkdtempSync(join(tmpdir(), "cg-wt-unreadable-"));
  for (const repo of [cleanRepo, dirtyRepo]) {
    await sh(repo, "git", "init", "-b", "main");
    await sh(repo, "git", "config", "user.email", "t@t");
    await sh(repo, "git", "config", "user.name", "t");
    await Bun.write(join(repo, "a.txt"), "hello");
    await sh(repo, "git", "add", "-A");
    await sh(repo, "git", "commit", "-m", "init");
  }
  await Bun.write(join(dirtyRepo, "scratch.txt"), "uncommitted"); // the dirt

  project = createProject(db, { name: "P", path: cleanRepo, baseBranch: "main" });
  const wt = db.query(
    `INSERT INTO worktrees (id, project_id, branch, path, base, state) VALUES (?1, ?2, ?3, ?4, 'main', 'active')`,
  );
  wt.run("wt-clean", project.id, "cg/1", cleanRepo);
  wt.run("wt-dirty", project.id, "cg/2", dirtyRepo);
  wt.run("wt-nonrepo", project.id, "cg/nonrepo", nonRepoDir);
  wt.run("wt-unreadable", project.id, "cg/unreadable", unreadableDir);

  cardClean = createCard(db, { projectId: project.id, title: "Fix parser", body: "Handle empty input.", agent: "claude" });
  cardDirty = createCard(db, { projectId: project.id, title: "Dirty task", body: "", agent: "claude" });
  cardNoWorktree = createCard(db, { projectId: project.id, title: "Detached task", body: "", agent: "claude" });
  cardNonRepo = createCard(db, { projectId: project.id, title: "Non-repo task", body: "", agent: "claude" });
  cardUnreadable = createCard(db, { projectId: project.id, title: "Unreadable task", body: "", agent: "claude" });
  for (const card of [cardClean, cardDirty, cardNoWorktree, cardNonRepo, cardUnreadable]) {
    updateCard(db, card.id, { phase: "working", workingSub: "running" });
  }

  const aClean = createAttempt(db, { cardId: cardClean.id, worktreeId: "wt-clean", beforeHead: null });
  const aDirty = createAttempt(db, { cardId: cardDirty.id, worktreeId: "wt-dirty", beforeHead: null });
  attemptCleanId = aClean.id;
  dispatchClean = createDispatch(db, aClean.id).id;
  dispatchDirty = createDispatch(db, aDirty.id).id;
  dispatchNoWorktree = createDispatch(db, createAttempt(db, { cardId: cardNoWorktree.id, worktreeId: null, beforeHead: null }).id).id;
  dispatchNonRepo = createDispatch(db, createAttempt(db, { cardId: cardNonRepo.id, worktreeId: "wt-nonrepo", beforeHead: null }).id).id;
  dispatchUnreadable = createDispatch(db, createAttempt(db, { cardId: cardUnreadable.id, worktreeId: "wt-unreadable", beforeHead: null }).id).id;
  chmodSync(unreadableDir, 0o000);
  domainEvents.length = 0; // seeding is not under test

  sidecar = spawnSidecar({
    CODEGENT_HOOK_PORT: String(rx.port),
    CODEGENT_HOOK_TOKEN: rx.token,
    CODEGENT_CARD_ID: String(cardClean.id),
    CODEGENT_DISPATCH_ID: dispatchClean,
  });
}, 30_000);

afterAll(async () => {
  offEvents();
  await sidecar?.stop();
  rx.stop();
  chmodSync(unreadableDir, 0o700);
  for (const d of [dataDir, cleanRepo, dirtyRepo, nonRepoDir, unreadableDir]) rmSync(d, { recursive: true, force: true });
});

test("sidecar handshake + tools/list: EXACTLY the three task tools (spec §6)", async () => {
  const init = await handshake(sidecar);
  expect(init.serverInfo.name).toBe("codegent");
  const list = await sidecar.request("tools/list", {});
  const names = list.result.tools.map((t: any) => t.name).sort();
  expect(names).toEqual(["task_complete", "task_get", "task_progress"]); // no task_ask_user, nothing else
  const progress = list.result.tools.find((t: any) => t.name === "task_progress");
  expect(progress.inputSchema.required).toEqual(["note"]);
  const complete = list.result.tools.find((t: any) => t.name === "task_complete");
  expect(complete.inputSchema.required).toEqual(["summary"]);
}, 20_000);

test("task_get roundtrips card title/body through the daemon agent route", async () => {
  const res = await sidecar.request("tools/call", { name: "task_get", arguments: {} });
  expect(res.result.isError).toBeFalsy();
  const payload = JSON.parse(res.result.content[0].text);
  expect(payload).toEqual({
    title: "Fix parser",
    body: "Handle empty input.",
    acceptance: null,
    dispatch: dispatchClean,
  });
}, 20_000);

test("task_progress appends a timeline row and touches the dispatch heartbeat", async () => {
  const res = await sidecar.request("tools/call", {
    name: "task_progress", arguments: { note: "parsed the grammar, tests next" },
  });
  expect(res.result.isError).toBeFalsy();
  const rows = listTimeline(db, cardClean.id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.kind).toBe("progress");
  expect(rows[0]!.text).toBe("parsed the grammar, tests next");
  const d = db.query(`SELECT last_progress_at FROM dispatches WHERE id = ?1`).get(dispatchClean) as any;
  expect(d.last_progress_at).toBeGreaterThan(0); // the heartbeat T8 reads
}, 20_000);

test("task_complete on a DIRTY worktree → MCP tool error carrying the porcelain (agent-only echo)", async () => {
  const dirty = spawnSidecar({
    CODEGENT_HOOK_PORT: String(rx.port),
    CODEGENT_HOOK_TOKEN: rx.token,
    CODEGENT_CARD_ID: String(cardDirty.id),
    CODEGENT_DISPATCH_ID: dispatchDirty,
  });
  try {
    await handshake(dirty);
    const res = await dirty.request("tools/call", {
      name: "task_complete", arguments: { summary: "done i think" },
    });
    expect(res.result.isError).toBe(true);
    const text = res.result.content[0].text as string;
    expect(text).toContain("worktree has uncommitted changes:");
    expect(text).toContain("?? scratch.txt"); // the porcelain line, verbatim
    // Rejected: no marker, no transition, and NOTHING on the domain bus.
    expect(pendingComplete(db, dispatchDirty)).toBe(false);
    const card = listCards(db, project.id).find(c => c.id === cardDirty.id)!;
    expect(card.phase).toBe("working");
  } finally {
    await dirty.stop();
  }
}, 20_000);

test("task_complete fails closed when its worktree is missing, non-repository, or unreadable", async () => {
  const fixtures = [
    { card: cardNoWorktree, dispatch: dispatchNoWorktree, error: "completion requires an attached worktree" },
    { card: cardNonRepo, dispatch: dispatchNonRepo, error: "worktree cleanliness could not be verified" },
    { card: cardUnreadable, dispatch: dispatchUnreadable, error: "worktree cleanliness could not be verified" },
  ];
  for (const fixture of fixtures) {
    const client = spawnSidecar({
      CODEGENT_HOOK_PORT: String(rx.port),
      CODEGENT_HOOK_TOKEN: rx.token,
      CODEGENT_CARD_ID: String(fixture.card.id),
      CODEGENT_DISPATCH_ID: fixture.dispatch,
    });
    try {
      await handshake(client);
      const res = await client.request("tools/call", {
        name: "task_complete",
        arguments: { summary: "cannot be trusted as clean" },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain(fixture.error);
      expect(pendingComplete(db, fixture.dispatch)).toBe(false);
    } finally {
      await client.stop();
    }
  }
}, 30_000);

test("task_complete on a CLEAN worktree → 200, latch-guarded pending marker, card untouched", async () => {
  const res = await sidecar.request("tools/call", {
    name: "task_complete", arguments: { summary: "parser fixed, tests green" },
  });
  expect(res.result.isError).toBeFalsy();
  expect(pendingComplete(db, dispatchClean)).toBe(true);
  // Marker only — the dispatch is still running (T8 owns the completion latch)
  // and the card must NOT transition (no engine yet).
  const d = db.query(`SELECT status FROM dispatches WHERE id = ?1`).get(dispatchClean) as any;
  expect(d.status).toBe("running");
  const card = listCards(db, project.id).find(c => c.id === cardClean.id)!;
  expect(card.phase).toBe("working");
}, 20_000);

test("no domain event was emitted by any agent-plane call (spec §6.1: nothing reaches the UI)", () => {
  expect(domainEvents).toEqual([]);
});

test("stale dispatch (terminal status) never records the marker — write-once latch holds", async () => {
  const stale = createDispatch(db, attemptCleanId).id;
  expect(completeDispatch(db, stale, "failed")).not.toBeNull(); // dispatch already terminal
  const r = await fetch(`${api}/complete`, {
    ...H, method: "POST",
    body: JSON.stringify({ card: cardClean.id, dispatch: stale, summary: "late retry" }),
  });
  expect(r.status).toBe(200); // acknowledged and dropped — a stale retry is not the agent's error
  expect((await r.json()).stale).toBe(true);
  expect(pendingComplete(db, stale)).toBe(false);
});

test("crossed card-dispatch envelope ids 404 instead of acting on the wrong rows", async () => {
  // dispatchClean belongs to cardClean — pairing it with cardDirty must 404.
  const progressRowsBefore = listTimeline(db, cardClean.id).length;
  const crossedComplete = await fetch(`${api}/complete`, {
    ...H, method: "POST",
    body: JSON.stringify({ card: cardDirty.id, dispatch: dispatchClean, summary: "crossed" }),
  });
  expect(crossedComplete.status).toBe(404);
  const crossedProgress = await fetch(`${api}/progress`, {
    ...H, method: "POST",
    body: JSON.stringify({ card: cardClean.id, dispatch: dispatchDirty, note: "crossed" }),
  });
  expect(crossedProgress.status).toBe(404);
  const crossedGet = await fetch(
    `${api}/task?card=${cardDirty.id}&dispatch=${encodeURIComponent(dispatchClean)}`,
    H,
  );
  expect(crossedGet.status).toBe(404);
  // Nothing landed: no timeline rows, no heartbeat on the foreign dispatch.
  expect(listTimeline(db, cardClean.id).length).toBe(progressRowsBefore);
  const d = db.query(`SELECT last_progress_at FROM dispatches WHERE id = ?1`).get(dispatchDirty) as any;
  expect(d.last_progress_at).toBeNull();
});

test("accepted completion persisted the summary as a round timeline row (Details drawer only)", () => {
  const round = listTimeline(db, cardClean.id).filter(r => r.kind === "round");
  expect(round.length).toBe(1);
  expect(round[0]!.text).toBe("parser fixed, tests green");
});

test("agent routes: ghost card 404s before body validation; missing fields 400", async () => {
  const ghost = await fetch(`${api}/task?card=99999`, H);
  expect(ghost.status).toBe(404);
  const ghostPost = await fetch(`${api}/progress`, {
    ...H, method: "POST", body: JSON.stringify({ card: 99999, note: 42 }), // invalid body too
  });
  expect(ghostPost.status).toBe(404); // 404-before-400, same precedence as the project routes
  const noNote = await fetch(`${api}/progress`, {
    ...H, method: "POST", body: JSON.stringify({ card: cardClean.id, dispatch: dispatchClean }),
  });
  expect(noNote.status).toBe(400);
  const noDispatch = await fetch(`${api}/complete`, {
    ...H, method: "POST", body: JSON.stringify({ card: cardClean.id, summary: "x" }),
  });
  expect(noDispatch.status).toBe(404); // unknown dispatch
});
