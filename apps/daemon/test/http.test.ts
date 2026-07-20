import { test, expect, afterAll } from "bun:test";
import { openDb } from "../src/store/db";
import { PtyManager } from "../src/pty/manager";
import { startServer } from "../src/http/server";
import { Engine } from "../src/orchestrator/engine";
import { events as bus } from "../src/events";
import { appendTimeline } from "../src/store/timeline";
import { createAttempt, createDispatch } from "../src/store/attempts";
import { getCard, updateCard } from "../src/store/cards";
import { decodeEnvelope, encodeEnvelope } from "@codegent/protocol";

const db = openDb(":memory:");
const dataDir = `/tmp/cg-http-${crypto.randomUUID()}`;
const ptys = new PtyManager(db, dataDir);
// No adapters registered: R1 has nothing startable, action routes still mount.
const engine = new Engine({ db, ptys, adapters: { claude: null, codex: null }, events: bus, clock: Date.now });
const cfg = { port: 4790 + Math.floor(Math.random() * 100), dataDir, token: "testtoken" };
const srv = startServer(cfg, db, ptys, engine);
const base = `${srv.url}api`;
const T = { headers: { "x-codegent-token": "testtoken", "content-type": "application/json" } };

afterAll(() => srv.stop());

test("auth required", async () => {
  const r = await fetch(`${base}/projects`);
  expect(r.status).toBe(401);
  const w = await fetch(`${srv.url}ws`);
  expect(w.status).toBe(401);
});

test("project + card REST roundtrip + ws event", async () => {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const events: any[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "event") events.push(e.ev); };
  await new Promise(r => (ws.onopen = r));

  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "X", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "hello", body: "", agent: "none" }) })).json();
  expect(c.phase).toBe("queued");
  const edited = await (await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ title: "hello again", body: "details" }) })).json();
  expect(edited.title).toBe("hello again");
  expect(edited.phase).toBe("queued");
  // symbols-only worktree name must be rejected at the API boundary, not by git
  const bad = await fetch(`${base}/projects/${p.id}/worktrees`, { ...T, method: "POST", body: JSON.stringify({ name: "###" }) });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid name");
  await Bun.sleep(200);
  expect(events.some(e => e.t === "card" && e.card.title === "hello again")).toBe(true);
  ws.close();
}, 15000);

test("protocol-invalid bodies 400 at the boundary; valid ones still flow", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "V", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "boundary" }) })).json();
  expect(c.phase).toBe("queued");

  // invalid agent on create → 400
  const badAgent = await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "x", agent: "gpt" }) });
  expect(badAgent.status).toBe(400);
  expect((await badAgent.json()).error).toContain("agent");

  // Machine-owned fields are rejected even when their values are otherwise
  // protocol-valid. Ordinary PATCH is strictly editable content only.
  for (const patch of [
    { phase: "review" },
    { worktreeId: "wt-user-forged" },
    { position: 0 },
    { agent: "codex" },
    { auto: false },
  ]) {
    const rejected = await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify(patch) });
    expect(rejected.status).toBe(400);
  }
  const cards = await (await fetch(`${base}/projects/${p.id}/cards`, T)).json();
  expect(cards.find((k: any) => k.id === c.id).phase).toBe("queued");
  expect(cards.find((k: any) => k.id === c.id).worktreeId).toBeNull();

  // A valid content PATCH still 200s and still fans out as a ws event.
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const events: any[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "event") events.push(e.ev); };
  await new Promise(r => (ws.onopen = r));
  const ok = await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ title: "edited", body: "safe" }) });
  expect(ok.status).toBe(200);
  expect((await ok.json()).title).toBe("edited");
  await Bun.sleep(200);
  expect(events.some(e => e.t === "card" && e.card.id === c.id && e.card.title === "edited")).toBe(true);
  ws.close();
}, 15000);

test('PATCH with v0.1 phase "waiting" → 400, card unchanged', async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "W", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "legacy" }) })).json();
  const r = await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ phase: "waiting" }) });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("phase");
  const cards = await (await fetch(`${base}/projects/${p.id}/cards`, T)).json();
  expect(cards.find((k: any) => k.id === c.id).phase).toBe("queued");
}, 15000);

test("POST under a ghost project → 404 project not found, all three routes", async () => {
  // Valid bodies on purpose: the failure must be the missing project (404),
  // never body validation (400) — and the cards FK 500 must be gone.
  const routes: Array<[string, unknown]> = [
    ["cards", { title: "x" }],
    ["sessions", { title: "x" }],
    ["worktrees", { name: "x" }],
  ];
  for (const [route, body] of routes) {
    const r = await fetch(`${base}/projects/ghost/${route}`, { ...T, method: "POST", body: JSON.stringify(body) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("project not found");
  }
}, 15000);

test("POST under a ghost project with an INVALID body → still 404 (404-before-400 precedence)", async () => {
  // The missing parent must win over body validation on every project-scoped
  // POST — otherwise the error class depends on payload quality and probing
  // bodies against ghost projects leaks validation behavior.
  const routes: Array<[string, unknown]> = [
    ["cards", { title: 123 }],
    ["sessions", { cwd: 42 }],
    ["worktrees", { base: 42 }],
  ];
  for (const [route, body] of routes) {
    const r = await fetch(`${base}/projects/ghost/${route}`, { ...T, method: "POST", body: JSON.stringify(body) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("project not found");
  }
}, 15000);

test("POST sessions on a real project still opens a shell (cwd falls back to project path)", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "S", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const r = await fetch(`${base}/projects/${p.id}/sessions`, { ...T, method: "POST", body: JSON.stringify({}) });
  expect(r.status).toBe(201);
  const meta = await r.json();
  expect(meta.kind).toBe("shell");
  expect(meta.cwd).toBe("/tmp");
  await fetch(`${base}/sessions/${meta.id}`, { ...T, method: "DELETE" });
}, 15000);

test("board reorder + worker limit routes (T8)", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "RL", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  expect(p.workerLimit).toBe(1); // default
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "one" }) })).json();

  const moved = await fetch(`${base}/projects/${p.id}/cards/${c.id}/position`, { ...T, method: "PATCH", body: JSON.stringify({ position: 0.5 }) });
  expect(moved.status).toBe(200);
  expect((await moved.json()).position).toBe(0.5);
  const toggled = await fetch(`${base}/cards/${c.id}/auto`, { ...T, method: "PATCH", body: JSON.stringify({ auto: false }) });
  expect(toggled.status).toBe(200);
  expect((await toggled.json()).auto).toBe(false);
  const agent = await fetch(`${base}/cards/${c.id}/agent`, { ...T, method: "PATCH", body: JSON.stringify({ agent: "codex" }) });
  expect(agent.status).toBe(200);
  expect((await agent.json()).agent).toBe("codex");
  db.query(`UPDATE cards SET phase = 'working', working_sub = 'starting' WHERE id = ?1`).run(c.id);
  const lateAuto = await fetch(`${base}/cards/${c.id}/auto`, { ...T, method: "PATCH", body: JSON.stringify({ auto: true }) });
  const lateAgent = await fetch(`${base}/cards/${c.id}/agent`, { ...T, method: "PATCH", body: JSON.stringify({ agent: "claude" }) });
  expect(lateAuto.status).toBe(409);
  expect(lateAgent.status).toBe(409);
  const ghost = await fetch(`${base}/projects/${p.id}/cards/999999/position`, { ...T, method: "PATCH", body: JSON.stringify({ position: 1 }) });
  expect(ghost.status).toBe(404);
  const badPos = await fetch(`${base}/projects/${p.id}/cards/${c.id}/position`, { ...T, method: "PATCH", body: JSON.stringify({ position: "top" }) });
  expect(badPos.status).toBe(400);

  const badLimit = await fetch(`${base}/projects/${p.id}`, { ...T, method: "PATCH", body: JSON.stringify({ workerLimit: 0 }) });
  expect(badLimit.status).toBe(400);
  const ok = await fetch(`${base}/projects/${p.id}`, { ...T, method: "PATCH", body: JSON.stringify({ workerLimit: 3 }) });
  expect(ok.status).toBe(200);
  expect((await ok.json()).workerLimit).toBe(3);
  const ghostProject = await fetch(`${base}/projects/ghost`, { ...T, method: "PATCH", body: JSON.stringify({ workerLimit: 2 }) });
  expect(ghostProject.status).toBe(404);
}, 15000);

test("card timeline route returns ordered rows and 404s unknown cards", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "TL", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "timeline" }) })).json();
  appendTimeline(db, c.id, "progress", "first note");
  appendTimeline(db, c.id, "round", "round two");

  const ok = await fetch(`${base}/cards/${c.id}/timeline`, T);
  expect(ok.status).toBe(200);
  const rows = await ok.json();
  expect(rows.map((row: any) => [row.kind, row.text])).toEqual([
    ["progress", "first note"],
    ["round", "round two"],
  ]);
  const ghost = await fetch(`${base}/cards/999999/timeline`, T);
  expect(ghost.status).toBe(404);
}, 15000);

test("action routes map engine rejections and expose legal cancel/delete paths", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "AC", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "n" }) })).json(); // agent defaults to none

  const start = await fetch(`${base}/cards/${c.id}/start`, { ...T, method: "POST" });
  expect(start.status).toBe(409); // a `none` card opens nothing agent-side
  const ghost = await fetch(`${base}/cards/999999/start`, { ...T, method: "POST" });
  expect(ghost.status).toBe(404);
  const stop = await fetch(`${base}/cards/${c.id}/stop`, { ...T, method: "POST" });
  expect(stop.status).toBe(409); // queued card cannot stop (IllegalTransition)
  const sendBack = await fetch(`${base}/cards/${c.id}/send-back`, { ...T, method: "POST", body: JSON.stringify({ comments: ["x"] }) });
  expect(sendBack.status).toBe(409); // not in review.ready
  const badComments = await fetch(`${base}/cards/${c.id}/send-back`, { ...T, method: "POST", body: JSON.stringify({ comments: [1] }) });
  expect(badComments.status).toBe(400);
  const cancelQueued = await fetch(`${base}/cards/${c.id}/cancel`, { ...T, method: "POST" });
  expect(cancelQueued.status).toBe(409);

  const review = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "review" }) })).json();
  db.query(`UPDATE cards SET phase = 'review', review_sub = 'ready' WHERE id = ?1`).run(review.id);
  const removeReview = await fetch(`${base}/cards/${review.id}`, { ...T, method: "DELETE" });
  expect(removeReview.status).toBe(409);
  const cancelReview = await fetch(`${base}/cards/${review.id}/cancel`, { ...T, method: "POST" });
  expect(cancelReview.status).toBe(200);
  expect((await cancelReview.json()).phase).toBe("cancelled");
  const removeCancelled = await fetch(`${base}/cards/${review.id}`, { ...T, method: "DELETE" });
  expect(removeCancelled.status).toBe(200);

  const working = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "working" }) })).json();
  db.query(`UPDATE cards SET phase = 'working', working_sub = 'running' WHERE id = ?1`).run(working.id);
  const removeWorking = await fetch(`${base}/cards/${working.id}`, { ...T, method: "DELETE" });
  expect(removeWorking.status).toBe(409);

  const removeQueued = await fetch(`${base}/cards/${c.id}`, { ...T, method: "DELETE" });
  expect(removeQueued.status).toBe(200);
  const done = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "done" }) })).json();
  db.query(`UPDATE cards SET phase = 'done' WHERE id = ?1`).run(done.id);
  const removeDone = await fetch(`${base}/cards/${done.id}`, { ...T, method: "DELETE" });
  expect(removeDone.status).toBe(200);
}, 15000);

test("mark-state is legal only on working cards and sets the manual input flag", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "MS", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const queued = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "queued" }) })).json();
  const queuedResult = await fetch(`${base}/cards/${queued.id}/mark-state`, { ...T, method: "POST", body: JSON.stringify({ state: "needs-input" }) });
  expect(queuedResult.status).toBe(409);

  const review = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "review" }) })).json();
  db.query(`UPDATE cards SET phase = 'review', review_sub = 'ready' WHERE id = ?1`).run(review.id);
  const reviewResult = await fetch(`${base}/cards/${review.id}/mark-state`, { ...T, method: "POST", body: JSON.stringify({ state: "needs-input" }) });
  expect(reviewResult.status).toBe(409);

  const working = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "working" }) })).json();
  db.query(`UPDATE cards SET phase = 'working', working_sub = 'running' WHERE id = ?1`).run(working.id);
  const contentBearing = await fetch(`${base}/cards/${working.id}/mark-state`, { ...T, method: "POST", body: JSON.stringify({ state: "needs-input", terminalContent: "not allowed" }) });
  expect(contentBearing.status).toBe(400);
  const marked = await fetch(`${base}/cards/${working.id}/mark-state`, { ...T, method: "POST", body: JSON.stringify({ state: "needs-input" }) });
  expect(marked.status).toBe(200);
  const card = await marked.json();
  expect(card.phase).toBe("working");
  expect(card.inputKind).toBe("question");
  expect(card.inputSince).toBeNumber();
}, 15000);

test("sticky mark-state override suppresses subsequent detection flag-clear and flag signals", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "Sticky", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const card = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "sticky" }) })).json();
  const attempt = createAttempt(db, { cardId: card.id, worktreeId: null, beforeHead: null });
  const dispatch = createDispatch(db, attempt.id);
  db.query(`UPDATE cards SET phase = 'working', working_sub = 'running', attempt_id = ?2 WHERE id = ?1`).run(card.id, attempt.id);

  const needsInput = await fetch(`${base}/cards/${card.id}/mark-state`, { ...T, method: "POST", body: JSON.stringify({ state: "needs-input" }) });
  expect(needsInput.status).toBe(200);
  engine.handleSignal(dispatch.id, { s: "flag-clear" });
  expect(getCard(db, card.id)?.inputKind).toBe("question");

  const running = await fetch(`${base}/cards/${card.id}/mark-state`, { ...T, method: "POST", body: JSON.stringify({ state: "running" }) });
  expect(running.status).toBe(200);
  engine.handleSignal(dispatch.id, { s: "flag", kind: "question" });
  expect(getCard(db, card.id)?.inputKind).toBeNull();
}, 15000);

test("terminal over ws: snapshot then live", async () => {
  const meta = ptys.open({ projectId: "p", cwd: "/tmp", title: "t" });
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const frames: string[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "term" && e.sid === meta.id) frames.push(Buffer.from(e.data, "base64").toString()); };
  await new Promise(r => (ws.onopen = r));
  ws.send(encodeEnvelope({ ch: "sub", sid: meta.id }));
  await Bun.sleep(300);
  ws.send(encodeEnvelope({ ch: "input", sid: meta.id, data: Buffer.from("printf 'WS_OK\\n'\r").toString("base64") }));
  await Bun.sleep(700);
  expect(frames.join("")).toContain("WS_OK");
  ws.close(); ptys.close(meta.id);
}, 20000);

test("terminal over ws: retained dead ring replays as a frozen session", async () => {
  const meta = ptys.open({
    projectId: "frozen", cwd: "/tmp", title: "frozen", kind: "agent", attemptId: 777,
    cmd: ["sh", "-c", "printf FROZEN_REPLAY"],
  });
  const process = ptys.get(meta.id)!;
  await process.exited; // includes the final serialized ring flush
  await Bun.sleep(0); // let PtyManager's exit continuation remove the live entry
  expect(ptys.get(meta.id)).toBeUndefined();

  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const replay = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("frozen replay timed out")), 3000);
    ws.onmessage = message => {
      const envelope = decodeEnvelope(String(message.data));
      if (envelope.ch !== "term" || envelope.sid !== meta.id) return;
      clearTimeout(timer);
      resolve(Buffer.from(envelope.data, "base64").toString());
    };
  });
  await new Promise(resolve => (ws.onopen = resolve));
  ws.send(encodeEnvelope({ ch: "sub", sid: meta.id }));
  expect(await replay).toContain("FROZEN_REPLAY");
  ws.close();
}, 20000);

test("diff + reviewed-files: guards and viewed-marks roundtrip", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "RV", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "review me" }) })).json();

  // unknown card → 404 on both surfaces
  expect((await fetch(`${base}/cards/999999/diff`, T)).status).toBe(404);
  expect((await fetch(`${base}/cards/999999/reviewed-files`, T)).status).toBe(404);

  // queued card: diff 409, PUT viewed 409, GET viewed open (empty)
  expect((await fetch(`${base}/cards/${c.id}/diff`, T)).status).toBe(409);
  const putQueued = await fetch(`${base}/cards/${c.id}/reviewed-files`, { ...T, method: "PUT", body: JSON.stringify({ path: "x.ts", viewed: true }) });
  expect(putQueued.status).toBe(409);
  expect(await (await fetch(`${base}/cards/${c.id}/reviewed-files`, T)).json()).toEqual({ paths: [] });

  // force review phase store-level (engine has no adapters here)
  updateCard(db, c.id, { phase: "review", reviewSub: "ready" });

  // review card without a worktree: diff is a stateful 409, not a 500
  const noWt = await fetch(`${base}/cards/${c.id}/diff`, T);
  expect(noWt.status).toBe(409);
  expect((await noWt.json()).error).toBe("card has no worktree");

  // viewed-marks roundtrip + validation
  const bad = await fetch(`${base}/cards/${c.id}/reviewed-files`, { ...T, method: "PUT", body: JSON.stringify({ path: "", viewed: "yes" }) });
  expect(bad.status).toBe(400);
  const on = await (await fetch(`${base}/cards/${c.id}/reviewed-files`, { ...T, method: "PUT", body: JSON.stringify({ path: "src/a.ts", viewed: true }) })).json();
  expect(on.paths).toEqual(["src/a.ts"]);
  const off = await (await fetch(`${base}/cards/${c.id}/reviewed-files`, { ...T, method: "PUT", body: JSON.stringify({ path: "src/a.ts", viewed: false }) })).json();
  expect(off.paths).toEqual([]);
});
