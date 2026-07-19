import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { PtyManager } from "../src/pty/manager";
import { events } from "../src/events";

test("manager opens shell session, lists it, closes it, emits events", async () => {
  const db = openDb(":memory:");
  const seen: string[] = [];
  const off = events.on(e => { if (e.t === "session") seen.push(`${e.session.id}:${e.session.live}`); });
  const m = new PtyManager(db, `/tmp/codegent-test-${crypto.randomUUID()}`);
  const meta = m.open({ projectId: "p1", cwd: "/tmp", title: "main" });
  expect(m.list("p1").length).toBe(1);
  expect(m.get(meta.id)).toBeDefined();
  m.close(meta.id);
  await Bun.sleep(300);
  expect(seen[0]).toBe(`${meta.id}:true`);
  expect(seen.at(-1)).toBe(`${meta.id}:false`);
  off();
}, 15000);
