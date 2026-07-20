import { describe, expect, test } from "bun:test";
import type { Card } from "@codegent/protocol";
import { attentionLabel, attentionOf, createNotifier } from "../notify";

const card = (over: Partial<Card>): Card => ({
  id: 1, projectId: "p", title: "Notify me", body: "", phase: "working", agent: "claude",
  worktreeId: null, position: 1, createdAt: 1000, updatedAt: 1000,
  workingSub: "running", errorKind: null, reviewSub: null, inputKind: null, inputSince: null,
  round: 1, auto: true, attemptId: 1, readySince: null, mergeSha: null,
  prNumber: null, prUrl: null, prState: null, ciStatus: null,
  ...over,
});

describe("attentionOf", () => {
  test("maps the three attention entries; running/queued/done are silent", () => {
    expect(attentionOf(card({ inputKind: "question" }))).toBe("waiting");
    expect(attentionOf(card({ inputKind: "silent" }))).toBe("waiting");
    expect(attentionOf(card({ workingSub: "error" }))).toBe("error");
    expect(attentionOf(card({ phase: "review", workingSub: null, reviewSub: "ready" }))).toBe("review-ready");
    expect(attentionOf(card({}))).toBeNull();
    expect(attentionOf(card({ phase: "queued", workingSub: null }))).toBeNull();
    expect(attentionOf(card({ phase: "done", workingSub: null }))).toBeNull();
    expect(attentionOf(card({ phase: "review", workingSub: null, reviewSub: "stale" }))).toBeNull();
  });
});

describe("createNotifier", () => {
  const setup = (opts?: { visible?: boolean; enabled?: boolean }) => {
    const fired: Array<{ title: string; body: string }> = [];
    const n = createNotifier({
      fire: (title, body) => fired.push({ title, body }),
      visible: () => opts?.visible ?? false,
      enabled: () => opts?.enabled ?? true,
    });
    return { fired, n };
  };

  test("fires once on attention ENTRY, not on repeats; refires on a new state", () => {
    const { fired, n } = setup();
    n.onEvent({ t: "card", card: card({}) }); // running — silent
    expect(fired.length).toBe(0);
    n.onEvent({ t: "card", card: card({ inputKind: "question" }) }); // → waiting
    n.onEvent({ t: "card", card: card({ inputKind: "question" }) }); // repeat (reconnect replay)
    expect(fired.length).toBe(1);
    expect(fired[0]).toEqual({ title: "Notify me", body: "waiting for input" });
    n.onEvent({ t: "card", card: card({ inputKind: null, workingSub: "error" }) }); // → error
    expect(fired.length).toBe(2);
    expect(fired[1]!.body).toBe("error");
    n.onEvent({ t: "card", card: card({ workingSub: null, phase: "review", reviewSub: "ready" }) });
    expect(fired[2]!.body).toBe(attentionLabel("review-ready"));
  });

  test("visible tab and disabled toggle both suppress (but state still tracks)", () => {
    const visible = setup({ visible: true });
    visible.n.onEvent({ t: "card", card: card({ inputKind: "question" }) });
    expect(visible.fired.length).toBe(0);

    const off = setup({ enabled: false });
    off.n.onEvent({ t: "card", card: card({ inputKind: "question" }) });
    expect(off.fired.length).toBe(0);
  });

  test("cardDeleted resets dedupe so a recreated id can notify again", () => {
    const { fired, n } = setup();
    n.onEvent({ t: "card", card: card({ inputKind: "question" }) });
    n.onEvent({ t: "cardDeleted", id: 1 });
    n.onEvent({ t: "card", card: card({ inputKind: "question" }) });
    expect(fired.length).toBe(2);
  });
});
