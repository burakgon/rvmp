import { describe, expect, test } from "bun:test";
import type { Card, SessionMeta } from "@rvmp/protocol";
import {
  cardRoutesToTerminal,
  columnOf,
  interruptedMessage,
  noticeCopy,
  railSessionEntries,
  reduceCardNotices,
  terminalSessionForCard,
} from "../projection";

const base: Card = {
  id: 1,
  projectId: "p",
  title: "Task",
  body: "",
  phase: "queued",
  agent: "claude",
  worktreeId: null,
  position: 1,
  createdAt: 1,
  updatedAt: 1,
  workingSub: null,
  errorKind: null,
  reviewSub: null,
  inputKind: null,
  inputSince: null,
  round: 1,
  auto: true,
  attemptId: null,
  executionMode: "inherit",
  readySince: null, mergeSha: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  ciStatus: null,
};

describe("columnOf", () => {
  test("projects every phase and orchestration-flag combination", () => {
    const phases: Card["phase"][] = ["queued", "working", "review", "done", "cancelled"];
    const inputKinds: Card["inputKind"][] = [null, "question", "permission", "silent"];
    const workingSubs: Card["workingSub"][] = [null, "starting", "running", "stopped", "error"];
    const errorKinds: Card["errorKind"][] = [null, "start_failed", "crashed", "interrupted"];

    for (const phase of phases) {
      for (const inputKind of inputKinds) {
        for (const workingSub of workingSubs) {
          for (const errorKind of errorKinds) {
            const card: Card = { ...base, phase, inputKind, workingSub, errorKind };
            const expected = phase === "queued" ? "queue"
              : phase === "working" ? (inputKind === null ? "running" : "waiting")
              : phase === "review" ? "review"
              : phase === "done" ? "done"
              : null;
            expect(columnOf(card)).toBe(expected);
          }
        }
      }
    }
  });

  test("keeps queued start failures in Queue", () => {
    expect(columnOf({ ...base, errorKind: "start_failed" })).toBe("queue");
  });
});

test("interruptedMessage pluralizes a project banner", () => {
  expect(interruptedMessage(1)).toBe("1 card interrupted — resume from its card");
  expect(interruptedMessage(2)).toBe("2 cards interrupted — resume from their cards");
});

test("notice projection stores fixed-copy chips and clears on the next card event", () => {
  let notices = reduceCardNotices(new Map(), { t: "notice", cardId: base.id, kind: "heartbeat-quiet" });
  expect(notices.get(base.id)).toBe("heartbeat-quiet");
  expect(noticeCopy(notices.get(base.id)!)).toBe("quiet 10m+");

  notices = reduceCardNotices(notices, { t: "notice", cardId: base.id, kind: "runaway" });
  expect(noticeCopy(notices.get(base.id)!)).toBe("still running");

  notices = reduceCardNotices(notices, { t: "notice", cardId: base.id, kind: "mismatch" });
  expect(noticeCopy(notices.get(base.id)!)).toBe("state mismatch");

  // A fresh card event is newer truth even when the card is still working.
  notices = reduceCardNotices(notices, {
    t: "card",
    card: { ...base, phase: "working", workingSub: "running" },
  });
  expect(notices.has(base.id)).toBe(false);

  notices = reduceCardNotices(notices, { t: "notice", cardId: base.id, kind: "heartbeat-quiet" });
  notices = reduceCardNotices(notices, { t: "card", card: { ...base, phase: "review", reviewSub: "ready" } });
  expect(notices.has(base.id)).toBe(false); // leaving working clears too
});

test("B4: mismatch badge clears when the watchdog reports detection agreement", () => {
  let notices = reduceCardNotices(new Map(), {
    t: "notice",
    cardId: base.id,
    kind: "mismatch",
  });
  expect(notices.get(base.id)).toBe("mismatch");

  notices = reduceCardNotices(notices, {
    t: "notice-clear",
    cardId: base.id,
    kind: "mismatch",
  });
  expect(notices.has(base.id)).toBe(false);
});

const session = (over: Partial<SessionMeta> & Pick<SessionMeta, "id" | "kind" | "live" | "createdAt">): SessionMeta => ({
  id: over.id,
  projectId: "p",
  kind: over.kind,
  title: over.title ?? over.id,
  cwd: "/tmp",
  worktreeId: null,
  live: over.live,
  createdAt: over.createdAt,
  adapterSessionId: null,
  attemptId: over.attemptId ?? null,
});

describe("terminal session projections", () => {
  test("rail puts live agents then the replayable current-attempt ring above unchanged shells", () => {
    const sessions = [
      session({ id: "shell-a", kind: "shell", live: true, createdAt: 1 }),
      session({ id: "dead-old", kind: "agent", live: false, createdAt: 2, attemptId: 7 }),
      session({ id: "shell-dead", kind: "shell", live: false, createdAt: 3 }),
      session({ id: "dead-new", kind: "agent", live: false, createdAt: 4, attemptId: 7 }),
      session({ id: "live-agent", kind: "agent", live: true, createdAt: 5, attemptId: 7 }),
      session({ id: "dead-stale", kind: "agent", live: false, createdAt: 6, attemptId: 99 }),
      session({ id: "shell-b", kind: "shell", live: true, createdAt: 7 }),
    ];
    const entries = railSessionEntries(sessions, [{ ...base, attemptId: 7, agent: "codex" }]);

    expect(entries.map(entry => entry.session.id)).toEqual(["live-agent", "dead-new", "shell-a", "shell-b"]);
    expect(entries.map(entry => entry.agent)).toEqual(["codex", "codex", null, null]);
    expect(entries.map(entry => entry.previous)).toEqual([false, true, false, false]);
    expect(entries.slice(0, 2).map(entry => entry.state)).toEqual(["queued", "queued"]);
  });

  test("rail orders attention first, then groups each card live-before-previous, with shells last", () => {
    const sessions = [
      session({ id: "shell-a", kind: "shell", live: true, createdAt: 1 }),
      session({ id: "running-a-live", kind: "agent", live: true, createdAt: 10, attemptId: 10 }),
      session({ id: "running-b-live", kind: "agent", live: true, createdAt: 15, attemptId: 11 }),
      session({ id: "input-live", kind: "agent", live: true, createdAt: 20, attemptId: 12 }),
      session({ id: "review-live", kind: "agent", live: true, createdAt: 30, attemptId: 13 }),
      session({ id: "error-previous", kind: "agent", live: false, createdAt: 35, attemptId: 14 }),
      session({ id: "error-live", kind: "agent", live: true, createdAt: 40, attemptId: 14 }),
      session({ id: "running-a-previous", kind: "agent", live: false, createdAt: 45, attemptId: 10 }),
      session({ id: "shell-b", kind: "shell", live: true, createdAt: 50 }),
    ];
    const cards: Card[] = [
      { ...base, id: 10, title: "Running A", phase: "working", workingSub: "running", position: 1, attemptId: 10 },
      { ...base, id: 11, title: "Running B", phase: "working", workingSub: "running", position: 2, attemptId: 11 },
      { ...base, id: 12, title: "Needs input", phase: "working", workingSub: "running", inputKind: "question", position: 3, attemptId: 12 },
      { ...base, id: 13, title: "Review", phase: "review", reviewSub: "ready", position: 4, attemptId: 13 },
      { ...base, id: 14, title: "Error", phase: "working", workingSub: "error", errorKind: "crashed", position: 5, attemptId: 14 },
    ];

    expect(railSessionEntries(sessions, cards).map(entry => entry.session.id)).toEqual([
      "error-live",
      "error-previous",
      "input-live",
      "running-a-live",
      "running-a-previous",
      "running-b-live",
      "review-live",
      "shell-a",
      "shell-b",
    ]);
  });

  test("card routing covers running/waiting, stopped, and errors, with live focus precedence", () => {
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "running" })).toBe(true);
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "error" })).toBe(true);
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "starting" })).toBe(false);
    expect(cardRoutesToTerminal({ phase: "working", workingSub: "stopped" })).toBe(true);
    expect(cardRoutesToTerminal({ phase: "review", workingSub: null })).toBe(false);

    const frozen = session({ id: "frozen", kind: "agent", live: false, createdAt: 20, attemptId: 7 });
    const live = session({ id: "live", kind: "agent", live: true, createdAt: 10, attemptId: 7 });
    expect(terminalSessionForCard({ attemptId: 7 }, [live, frozen])?.id).toBe("live");
    expect(terminalSessionForCard({ attemptId: 7 }, [frozen])?.id).toBe("frozen");
    expect(terminalSessionForCard({ attemptId: null }, [live])).toBeNull();
  });
});
