import { describe, expect, test } from "bun:test";
import { addPane, emptyLayout, movePane, normalizeSizes, removePane, sanitizeLayout } from "../terminalLayout";

describe("terminal layout", () => {
  test("opens four panes without silently evicting one and refuses a fifth", () => {
    let layout = emptyLayout();
    for (const id of ["a", "b", "c", "d"]) layout = addPane(layout, id).layout;
    const fifth = addPane(layout, "e");
    expect(fifth.added).toBe(false);
    expect(fifth.layout.open).toEqual(["a", "b", "c", "d"]);
    expect(fifth.layout.sizes.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  test("close, move and persisted-state sanitization preserve a valid focus", () => {
    let layout = emptyLayout();
    layout = addPane(layout, "a").layout;
    layout = addPane(layout, "b").layout;
    layout = addPane(layout, "c").layout;
    layout = movePane(layout, "c", -1);
    expect(layout.open).toEqual(["a", "c", "b"]);
    layout = removePane(layout, "c");
    expect(layout.focused).toBe("b");
    const clean = sanitizeLayout({ ...layout, open: ["a", "ghost", "a", "b"], focused: "ghost" }, new Set(["a", "b"]));
    expect(clean.open).toEqual(["a", "b"]);
    expect(clean.focused).toBe("a");
    expect(normalizeSizes([2, 1], 2)).toEqual([2 / 3, 1 / 3]);
  });
});
