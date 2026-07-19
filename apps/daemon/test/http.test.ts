import { test, expect, afterAll } from "bun:test";
import { openDb } from "../src/store/db";
import { PtyManager } from "../src/pty/manager";
import { startServer } from "../src/http/server";
import { decodeEnvelope, encodeEnvelope } from "@codegent/protocol";

const db = openDb(":memory:");
const dataDir = `/tmp/cg-http-${crypto.randomUUID()}`;
const ptys = new PtyManager(db, dataDir);
const cfg = { port: 4790 + Math.floor(Math.random() * 100), dataDir, token: "testtoken" };
const srv = startServer(cfg, db, ptys);
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
  const moved = await (await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ phase: "running" }) })).json();
  expect(moved.phase).toBe("running");
  // symbols-only worktree name must be rejected at the API boundary, not by git
  const bad = await fetch(`${base}/projects/${p.id}/worktrees`, { ...T, method: "POST", body: JSON.stringify({ name: "###" }) });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid name");
  await Bun.sleep(200);
  expect(events.some(e => e.t === "card" && e.card.phase === "running")).toBe(true);
  ws.close();
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
