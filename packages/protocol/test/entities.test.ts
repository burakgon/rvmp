import { test, expect } from "bun:test";
import {
  CardSchema, CiStatus, DiffFileStatus, PrState, ProjectSchema, WorktreeSchema, WorktreeSync,
  type DiffPayload,
} from "../src/entities";

test("card schema accepts a valid card and rejects bad phase", () => {
  const ok = CardSchema.safeParse({
    id: 1, projectId: "p1", title: "t", body: "", phase: "queued",
    agent: "claude", worktreeId: null, position: 0, createdAt: 1, updatedAt: 1,
    workingSub: null, errorKind: null, reviewSub: null,
    inputKind: null, inputSince: null, round: 1, auto: true, attemptId: null,
    readySince: null, prNumber: null, prUrl: null, prState: null, ciStatus: null,
  });
  expect(ok.success).toBe(true);
  const bad = CardSchema.safeParse({ ...ok.data, phase: "flying" } as any);
  expect(bad.success).toBe(false);
});

test("project schema requires absolute-ish path", () => {
  expect(ProjectSchema.safeParse({ id: "p", name: "n", path: "/tmp/x", baseBranch: "main", createdAt: 1 }).success).toBe(true);
});

test("v0.3 review enums, worktree defaults, and diff types match the contract", () => {
  expect(WorktreeSync.options).toEqual(["clean", "behind", "conflicted", "updating", "untracked"]);
  expect(PrState.options).toEqual(["open", "merged", "closed"]);
  expect(CiStatus.options).toEqual(["pending", "pass", "fail"]);
  expect(DiffFileStatus.options).toEqual(["M", "A", "D", "R"]);

  const worktree = WorktreeSchema.parse({
    id: "w1", projectId: "p1", branch: "cg/1-task", path: "/tmp/w1", base: "main", state: "active",
  });
  expect(worktree.sync).toBe("clean");
  expect(worktree.behindCount).toBe(0);
  expect(() => WorktreeSchema.parse({ ...worktree, behindCount: -1 })).toThrow();

  const payload: DiffPayload = {
    branch: "cg/1-task", base: "main", additions: 1, deletions: 0,
    files: [{
      path: "src/a.ts", oldPath: null, status: "M", additions: 1, deletions: 0,
      binary: false, truncated: false,
      hunks: [{ header: "@@ -1 +1 @@", lines: [{ t: "add", text: "next", oldNo: null, newNo: 1 }] }],
    }],
  };
  expect(payload.files[0]?.status).toBe("M");
});
