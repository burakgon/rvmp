import { describe, expect, test } from "bun:test";
import { CardSchema, AttemptSchema, DispatchSchema, SessionMetaSchema } from "../src/entities";
import { DomainEventSchema } from "../src/events";

const baseCard = {
  id: 1, projectId: "p1", title: "t", body: "", phase: "working", agent: "claude",
  worktreeId: "w1", position: 1, createdAt: 1, updatedAt: 1,
  workingSub: "running", errorKind: null, reviewSub: null,
  inputKind: null, inputSince: null, round: 1, auto: true, attemptId: 1,
  readySince: null, mergeSha: null, prNumber: null, prUrl: null, prState: null, ciStatus: null,
};

describe("v0.2 entities", () => {
  test("card accepts spec-true shape", () => {
    expect(CardSchema.parse(baseCard).workingSub).toBe("running");
  });
  test("waiting is not a phase", () => {
    expect(() => CardSchema.parse({ ...baseCard, phase: "waiting" })).toThrow();
  });
  test("input flag kinds", () => {
    for (const k of ["question", "permission", "silent"] as const)
      expect(CardSchema.parse({ ...baseCard, inputKind: k, inputSince: 5 }).inputKind).toBe(k);
    expect(() => CardSchema.parse({ ...baseCard, inputKind: "shout" })).toThrow();
  });
  test("recognized universal agents are representable and arbitrary labels are rejected", () => {
    for (const agent of ["gemini", "opencode", "aider", "amp", "goose", "generic"] as const) {
      expect(CardSchema.parse({ ...baseCard, agent }).agent).toBe(agent);
    }
    expect(() => CardSchema.parse({ ...baseCard, agent: "unknown-agent" })).toThrow();
  });
  test("attempt + dispatch schemas", () => {
    expect(AttemptSchema.parse({ id: 1, cardId: 1, worktreeId: "w", seq: 1, status: "running", beforeHead: "abc", createdAt: 1 }).seq).toBe(1);
    expect(DispatchSchema.parse({ id: "d1", attemptId: 1, status: "running", lastProgressAt: null, createdAt: 1 }).id).toBe("d1");
  });
  test("agent session meta", () => {
    const m = SessionMetaSchema.parse({
      id: "s", projectId: "p", kind: "agent", title: "t", cwd: "/x",
      worktreeId: null, live: true, createdAt: 1, adapterSessionId: "cc-123", attemptId: 1,
    });
    expect(m.kind).toBe("agent");
  });
  test("notice event carries no text payload", () => {
    const e = DomainEventSchema.parse({ t: "notice", cardId: 3, kind: "mismatch" });
    expect("message" in e).toBe(false);
    expect(Object.keys(e).sort()).toEqual(["cardId", "kind", "t"]);
    expect(() => DomainEventSchema.parse({ t: "notice", cardId: 3, kind: "mismatch", terminalContent: "boom" })).toThrow();
  });
  test("mismatch clear event is content-free", () => {
    const e = DomainEventSchema.parse({ t: "notice-clear", cardId: 3, kind: "mismatch" });
    expect(Object.keys(e).sort()).toEqual(["cardId", "kind", "t"]);
    expect(() => DomainEventSchema.parse({
      t: "notice-clear",
      cardId: 3,
      kind: "mismatch",
      terminalContent: "boom",
    })).toThrow();
  });
});
