import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { createProject, listProjects } from "../src/store/projects";
import { createCard, updateCard, deleteCard, listCards } from "../src/store/cards";

const db = openDb(":memory:");

test("project create/list", () => {
  const p = createProject(db, { name: "My App", path: "/tmp/myapp", baseBranch: "main" });
  expect(p.id).toMatch(/^my-app-[0-9a-f]{4}$/);
  expect(listProjects(db).length).toBe(1);
});

test("card lifecycle", () => {
  const p = createProject(db, { name: "B", path: "/tmp/b", baseBranch: "main" });
  const c1 = createCard(db, { projectId: p.id, title: "First", body: "", agent: "claude" });
  const c2 = createCard(db, { projectId: p.id, title: "Second", body: "", agent: "none" });
  expect(c1.phase).toBe("queued");
  expect(c2.position).toBeGreaterThan(c1.position);
  const moved = updateCard(db, c2.id, { phase: "running" });
  expect(moved.phase).toBe("running");
  deleteCard(db, c1.id);
  expect(listCards(db, p.id).map(c => c.id)).toEqual([c2.id]);
});
