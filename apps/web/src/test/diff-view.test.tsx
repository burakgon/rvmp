import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, DiffFile } from "@codegent/protocol";
import { FilesPanel, HunkList, QueuePill } from "../components/DiffView";
import { cardRoutesToDiff, reviewQueueOrder } from "../projection";

const reviewCard = (over: Partial<Card>): Card => ({
  id: 1, projectId: "p", title: "Review me", body: "", phase: "review", agent: "claude",
  worktreeId: "w1", position: 1, createdAt: 1000, updatedAt: 1000,
  workingSub: null, errorKind: null, reviewSub: "ready", inputKind: null, inputSince: null,
  round: 1, auto: true, attemptId: 1, readySince: 5000,
  prNumber: null, prUrl: null, prState: null, ciStatus: null,
  ...over,
});

const file = (over: Partial<DiffFile>): DiffFile => ({
  path: "src/a.ts", oldPath: null, status: "M", additions: 3, deletions: 1,
  binary: false, truncated: false,
  hunks: [{
    header: "@@ -1,3 +1,3 @@",
    lines: [
      { t: "ctx", text: "one", oldNo: 1, newNo: 1 },
      { t: "del", text: "two", oldNo: 2, newNo: null },
      { t: "add", text: "TWO", oldNo: null, newNo: 2 },
    ],
  }],
  ...over,
});

describe("projection routing + queue order", () => {
  test("review and done route to diff; working does not", () => {
    expect(cardRoutesToDiff({ phase: "review" })).toBe(true);
    expect(cardRoutesToDiff({ phase: "done" })).toBe(true);
    expect(cardRoutesToDiff({ phase: "working" })).toBe(false);
  });
  test("review queue orders by readySince ascending, nulls last", () => {
    const a = { id: 1, readySince: 300 };
    const b = { id: 2, readySince: 100 };
    const c = { id: 3, readySince: null };
    expect([a, b, c].sort(reviewQueueOrder).map(x => x.id)).toEqual([2, 1, 3]);
  });
});

describe("QueuePill", () => {
  test("shows stat, ready-since, and the stale update chip", () => {
    const html = renderToStaticMarkup(
      <QueuePill card={reviewCard({ reviewSub: "stale" })} summary={{ files: 2, additions: 9, deletions: 4 }}
        active={false} now={65_000} onSelect={() => {}} onUpdate={() => {}} />,
    );
    expect(html).toContain("Review me");
    expect(html).toContain("+9");
    expect(html).toContain("−4");
    expect(html).toContain("1m"); // ready-since 60s ago
    expect(html).toContain(">update<");
  });
  test("conflict pill carries the red conflict marker, no update chip", () => {
    const html = renderToStaticMarkup(
      <QueuePill card={reviewCard({ reviewSub: "conflict" })} summary={null} active
        now={65_000} onSelect={() => {}} onUpdate={() => {}} />,
    );
    expect(html).toContain("conflict");
    expect(html).not.toContain(">update<");
  });
});

describe("FilesPanel", () => {
  const files = [file({}), file({ path: "src/b.ts", status: "A" }), file({ path: "bin.dat", binary: true })];
  test("n/m reviewed header, viewed strikethrough, binary shows hint not checkbox", () => {
    const html = renderToStaticMarkup(
      <FilesPanel files={files} viewed={new Set(["src/a.ts"])} readOnly={false} onToggle={() => {}} onJump={() => {}} />,
    );
    expect(html).toContain("1/3 reviewed");
    expect(html).toContain("line-through");
    expect(html).toContain("bin");
    // exactly two checkboxes (binary row has none)
    expect(html.split('type="checkbox"').length - 1).toBe(2);
  });
  test("rename renders old → new", () => {
    const html = renderToStaticMarkup(
      <FilesPanel files={[file({ path: "d.ts", oldPath: "c.ts", status: "R" })]} viewed={new Set()} readOnly={false} onToggle={() => {}} onJump={() => {}} />,
    );
    expect(html).toContain("c.ts → d.ts");
  });
});

describe("HunkList", () => {
  test("renders hunk header, both line numbers, add/del markers", () => {
    const html = renderToStaticMarkup(<HunkList file={file({})} anchorId="f-0" />);
    expect(html).toContain("@@ -1,3 +1,3 @@");
    expect(html).toContain('data-line-t="del"');
    expect(html).toContain('data-line-t="add"');
    expect(html).toContain(">TWO<");
  });
  test("truncated file renders the open-terminal hint instead of hunks", () => {
    const html = renderToStaticMarkup(<HunkList file={file({ truncated: true, hunks: [] })} anchorId="f-1" />);
    expect(html).toContain("file too large");
    expect(html).not.toContain("@@");
  });
});
