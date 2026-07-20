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
  round: 1, auto: true, attemptId: 1, readySince: 5000, mergeSha: null,
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
    expect(html).toContain("1/2 reviewed"); // binary/truncated excluded from the denominator (review minor)
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

describe("comments store + serialization (T6)", () => {
  const { clearComments, commentsFor, deleteComment, editComment, queueComment, serializeComments } = require("../comments") as typeof import("../comments");
  test("queue / edit / delete / clear round-trip", () => {
    clearComments(77);
    queueComment(77, { path: "src/a.ts", line: 3, text: "rename this" });
    queueComment(77, { path: "src/b.ts", line: null, text: "file-level note" });
    expect(commentsFor(77).length).toBe(2);
    const first = commentsFor(77)[0]!;
    editComment(77, first.id, "rename this properly");
    expect(commentsFor(77)[0]!.text).toBe("rename this properly");
    editComment(77, first.id, "   "); // empty edit deletes
    expect(commentsFor(77).length).toBe(1);
    deleteComment(77, commentsFor(77)[0]!.id);
    expect(commentsFor(77)).toEqual([]);
  });
  test("serializeComments prefixes file:line and appends the general note", () => {
    clearComments(78);
    queueComment(78, { path: "src/a.ts", line: 3, text: "tighten the guard" });
    queueComment(78, { path: "docs/x.md", line: null, text: "update docs" });
    expect(serializeComments(78, "  overall: good  ")).toEqual([
      "src/a.ts:3: tighten the guard",
      "docs/x.md: update docs",
      "overall: good",
    ]);
    expect(serializeComments(78, "")).toHaveLength(2);
    clearComments(78);
  });
});

describe("splitRows + comment anchor (T6)", () => {
  const { splitRows, commentAnchor } = require("../components/DiffView") as typeof import("../components/DiffView");
  test("pairs del/add runs and keeps ctx on both sides", () => {
    const rows = splitRows([
      { t: "ctx", text: "one", oldNo: 1, newNo: 1 },
      { t: "del", text: "two", oldNo: 2, newNo: null },
      { t: "del", text: "three", oldNo: 3, newNo: null },
      { t: "add", text: "TWO", oldNo: null, newNo: 2 },
      { t: "ctx", text: "four", oldNo: 4, newNo: 3 },
    ]);
    expect(rows.length).toBe(4); // ctx, [del|add], [del|null], ctx
    expect(rows[0]!.left!.text).toBe("one");
    expect(rows[1]!).toMatchObject({ left: { text: "two" }, right: { text: "TWO" } });
    expect(rows[2]!).toMatchObject({ left: { text: "three" }, right: null });
    expect(rows[3]!.right!.text).toBe("four");
  });
  test("anchor is newNo, or oldNo for deletions", () => {
    expect(commentAnchor({ t: "add", text: "", oldNo: null, newNo: 7 })).toBe(7);
    expect(commentAnchor({ t: "ctx", text: "", oldNo: 5, newNo: 6 })).toBe(6);
    expect(commentAnchor({ t: "del", text: "", oldNo: 9, newNo: null })).toBe(9);
  });
});

describe("HunkList comments (T6)", () => {
  test("queued comment renders inline with queued · edit · delete; readOnly hides controls and gutter", () => {
    const f = file({});
    const comments = [{ id: "c1", path: "src/a.ts", line: 2, del: false, text: "why uppercase?" }];
    const editable = renderToStaticMarkup(
      <HunkList file={f} anchorId="x" mode="unified" comments={comments} readOnly={false}
        onQueue={() => {}} onEdit={() => {}} onDelete={() => {}} />,
    );
    expect(editable).toContain("why uppercase?");
    expect(editable).toContain("queued");
    expect(editable).toContain("edit");
    expect(editable).toContain("delete");
    expect(editable).toContain("diff-plus"); // hover gutter present when editable
    const readonly = renderToStaticMarkup(
      <HunkList file={f} anchorId="x" mode="unified" comments={comments} readOnly />,
    );
    expect(readonly).toContain("why uppercase?");
    expect(readonly).not.toContain(">edit<");
    expect(readonly).not.toContain("diff-plus");
  });
  test("split mode renders two columns", () => {
    const html = renderToStaticMarkup(<HunkList file={file({})} anchorId="y" mode="split" />);
    expect(html.split("data-split-row").length - 1).toBeGreaterThan(0);
    expect(html).toContain(">TWO<");
    expect(html).toContain(">two<");
  });
});

describe("comment side discriminator (review B6)", () => {
  test("a del-side comment renders only under the deleted line, not the same-numbered new line", () => {
    // old line 2 ("two") deleted, new line 2 ("TWO") added — same number, different lines
    const delComment = [{ id: "d1", path: "src/a.ts", line: 2, del: true, text: "keep the old wording" }];
    const html = renderToStaticMarkup(
      <HunkList file={file({})} anchorId="z" mode="unified" comments={delComment} readOnly />,
    );
    // renders exactly once (one CommentRow), anchored to the del row
    expect(html.split("keep the old wording").length - 1).toBe(1);
    const newSide = [{ id: "n1", path: "src/a.ts", line: 2, del: false, text: "uppercase intended?" }];
    const html2 = renderToStaticMarkup(
      <HunkList file={file({})} anchorId="z2" mode="unified" comments={newSide} readOnly />,
    );
    expect(html2.split("uppercase intended?").length - 1).toBe(1);
  });
});
