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
  const moved = updateCard(db, c2.id, { phase: "working" });
  expect(moved.phase).toBe("working");
  deleteCard(db, c1.id);
  expect(listCards(db, p.id).map(c => c.id)).toEqual([c2.id]);
});

test("card review and PR fields round-trip through the store patch surface", () => {
  const p = createProject(db, { name: "Review", path: "/tmp/review", baseBranch: "main" });
  const card = createCard(db, { projectId: p.id, title: "Review me", body: "", agent: "codex" });
  expect(card.readySince).toBeNull();
  expect(card.prNumber).toBeNull();
  expect(card.prUrl).toBeNull();
  expect(card.prState).toBeNull();
  expect(card.ciStatus).toBeNull();

  const updated = updateCard(db, card.id, {
    readySince: 1234,
    prNumber: 42,
    prUrl: "https://example.test/pull/42",
    prState: "open",
    ciStatus: "pending",
  });
  expect(updated.readySince).toBe(1234);
  expect(updated.prNumber).toBe(42);
  expect(updated.prUrl).toBe("https://example.test/pull/42");
  expect(updated.prState).toBe("open");
  expect(updated.ciStatus).toBe("pending");
  expect(listCards(db, p.id)).toContainEqual(updated);
});
