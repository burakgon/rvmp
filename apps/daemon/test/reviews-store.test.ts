import { expect, test } from "bun:test";
import { openDb } from "../src/store/db";
import { createProject } from "../src/store/projects";
import { createCard } from "../src/store/cards";
import {
  clearReviewed, invalidateReviewed, listReviewedFiles, setReviewed,
} from "../src/store/reviews";

const db = openDb(":memory:");
const project = createProject(db, { name: "Reviews", path: "/tmp/reviews", baseBranch: "main" });
const card = createCard(db, { projectId: project.id, title: "Review", body: "", agent: "claude" });

test("reviewed files round-trip and viewed:false removes a mark", () => {
  expect(listReviewedFiles(db, card.id)).toEqual([]);
  setReviewed(db, card.id, "src/b.ts", true);
  setReviewed(db, card.id, "src/a.ts", true);
  expect(listReviewedFiles(db, card.id)).toEqual(["src/a.ts", "src/b.ts"]);

  setReviewed(db, card.id, "src/a.ts", false);
  expect(listReviewedFiles(db, card.id)).toEqual(["src/b.ts"]);
});

test("invalidateReviewed removes only changed paths", () => {
  for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) setReviewed(db, card.id, path, true);
  invalidateReviewed(db, card.id, ["src/a.ts", "src/c.ts"]);
  expect(listReviewedFiles(db, card.id)).toEqual(["src/b.ts"]);
  invalidateReviewed(db, card.id, []);
  expect(listReviewedFiles(db, card.id)).toEqual(["src/b.ts"]);
});

test("clearReviewed removes every mark for only that card", () => {
  const other = createCard(db, { projectId: project.id, title: "Other", body: "", agent: "codex" });
  setReviewed(db, card.id, "src/card.ts", true);
  setReviewed(db, other.id, "src/other.ts", true);
  clearReviewed(db, card.id);
  expect(listReviewedFiles(db, card.id)).toEqual([]);
  expect(listReviewedFiles(db, other.id)).toEqual(["src/other.ts"]);
});
