import { expect, test } from "bun:test";
import { CardSchema, type Card, type InputKind } from "@codegent/protocol";
import {
  dispatchEffect, IllegalTransition, transition, type Effect, type MachineEvent,
} from "../src/orchestrator/machine";

const T0 = 1_000_000; // timestamps baked into every input card
const NOW = 5_000_000; // clock value passed to transition()

function mk(p: Partial<Card>): Card {
  return Object.freeze({
    id: 1, projectId: "p1", title: "t", body: "", phase: "queued",
    agent: "claude", worktreeId: "wt-1", position: 1,
    createdAt: T0, updatedAt: T0,
    workingSub: null, errorKind: null, reviewSub: null,
    inputKind: null, inputSince: null,
    round: 1, auto: true, attemptId: 7,
    ...p,
  } as Card);
}

/** Every reachable phase/sub shape (plus the v0.3-only review subs, which must
 * reject everything in v0.2). 17 shapes x 22 event instances = 374 pairs. */
const STATES = {
  "queued": {},
  "queued+start_failed": { errorKind: "start_failed" },
  "working.starting": { phase: "working", workingSub: "starting" },
  "working.running": { phase: "working", workingSub: "running" },
  "working.running+question": { phase: "working", workingSub: "running", inputKind: "question", inputSince: T0 },
  "working.running+permission": { phase: "working", workingSub: "running", inputKind: "permission", inputSince: T0 },
  "working.running+silent": { phase: "working", workingSub: "running", inputKind: "silent", inputSince: T0 },
  "working.stopped": { phase: "working", workingSub: "stopped" },
  "working.error(crashed)": { phase: "working", workingSub: "error", errorKind: "crashed" },
  "working.error(interrupted)": { phase: "working", workingSub: "error", errorKind: "interrupted" },
  "review.ready": { phase: "review", reviewSub: "ready" },
  "review.stale": { phase: "review", reviewSub: "stale" },
  "review.conflict": { phase: "review", reviewSub: "conflict" },
  "review.updating": { phase: "review", reviewSub: "updating" },
  "review.merging": { phase: "review", reviewSub: "merging" },
  "done": { phase: "done" },
  "cancelled": { phase: "cancelled" },
} satisfies Record<string, Partial<Card>>;
type StateName = keyof typeof STATES;

const EVENTS = {
  "start": { t: "start" },
  "session-started": { t: "session-started" },
  "start-failed": { t: "start-failed" },
  "flag:question": { t: "flag", kind: "question" },
  "flag:permission": { t: "flag", kind: "permission" },
  "flag:silent": { t: "flag", kind: "silent" },
  "flag-clear": { t: "flag-clear" },
  "mark-state:running": { t: "mark-state", state: "running" },
  "mark-state:needs-input": { t: "mark-state", state: "needs-input" },
  "complete": { t: "complete" },
  "stop-failure": { t: "stop-failure" },
  "crashed": { t: "crashed" },
  "interrupted": { t: "interrupted" },
  "user-stop": { t: "user-stop" },
  "send-back": { t: "send-back" },
  "merge-start": { t: "merge-start" },
  "merged": { t: "merged" },
  "cancel": { t: "cancel" },
  "requeue": { t: "requeue" },
  "resume": { t: "resume" },
  "restart": { t: "restart" },
  "discard": { t: "discard" },
} satisfies Record<string, MachineEvent>;
type EventName = keyof typeof EVENTS;

// --- shared post-state checks -----------------------------------------------

type Check = (after: Card, before: Card) => void;

const flagsCleared = (c: Card) => {
  expect(c.inputKind).toBeNull();
  expect(c.inputSince).toBeNull();
};
const toStarting: Check = (c) => {
  expect(c.phase).toBe("working");
  expect(c.workingSub).toBe("starting");
  expect(c.errorKind).toBeNull();
  expect(c.reviewSub).toBeNull();
  flagsCleared(c);
};
const toRunning: Check = (c) => {
  expect(c.phase).toBe("working");
  expect(c.workingSub).toBe("running");
};
const toErrorK = (kind: "crashed" | "interrupted"): Check => (c) => {
  expect(c.phase).toBe("working");
  expect(c.workingSub).toBe("error");
  expect(c.errorKind).toBe(kind);
  flagsCleared(c);
};
const toCancelled: Check = (c) => {
  expect(c.phase).toBe("cancelled");
  expect(c.workingSub).toBeNull();
  expect(c.errorKind).toBeNull();
  expect(c.reviewSub).toBeNull();
  flagsCleared(c);
};
const toRequeued: Check = (c) => {
  expect(c.phase).toBe("queued");
  expect(c.workingSub).toBeNull();
  expect(c.errorKind).toBeNull();
  expect(c.auto).toBe(false); // won't auto-restart into the same failure (spec 9.1)
  flagsCleared(c);
};
const toFlagged = (kind: InputKind): Check => (c) => {
  toRunning(c, c); // flags never change phase
  expect(c.inputKind).toBe(kind);
  expect(c.inputSince).toBe(NOW);
};
const toReviewReady: Check = (c, before) => {
  expect(c.phase).toBe("review");
  expect(c.reviewSub).toBe("ready");
  expect(c.workingSub).toBeNull();
  expect(c.errorKind).toBeNull();
  flagsCleared(c);
  expect(c.round).toBe(before.round); // complete increments nothing
};

// --- the authoritative legal table (spec 4.1, v0.2 rows) --------------------

type Row = [from: StateName, ev: EventName, effects: Effect[], check: Check];

const LEGAL: Row[] = [
  // queued -> starting (user start / R1); retry after start_failed is the same row
  ["queued", "start", ["create-worktree", "spawn-agent"], toStarting],
  ["queued+start_failed", "start", ["create-worktree", "spawn-agent"], toStarting],
  // starting -> running (session-start hook)
  ["working.starting", "session-started", [], toRunning],
  // starting -> error(start_failed): phase stays queued visually, partial worktree rolled back, no push
  ["working.starting", "start-failed", ["archive-worktree"], (c) => {
    expect(c.phase).toBe("queued");
    expect(c.workingSub).toBeNull();
    expect(c.errorKind).toBe("start_failed");
  }],
  ["working.starting", "crashed", ["push"], toErrorK("crashed")],
  ["working.starting", "interrupted", [], toErrorK("interrupted")],
  ["working.starting", "cancel", ["archive-worktree"], toCancelled],
];

const RUNNING_STATES = [
  "working.running", "working.running+question",
  "working.running+permission", "working.running+silent",
] as const satisfies readonly StateName[];
for (const s of RUNNING_STATES) {
  LEGAL.push(
    // running -> +input flag (flag while flagged replaces the kind); silent never pushes (spec 11)
    [s, "flag:question", ["push"], toFlagged("question")],
    [s, "flag:permission", ["push"], toFlagged("permission")],
    [s, "flag:silent", [], toFlagged("silent")],
    // running -> review.ready (completion truth table): diffstat + push
    [s, "complete", ["compute-diffstat", "push"], toReviewReady],
    // StopFailure (API-error turn) -> error; lands error(crashed), which pushes (spec 11 error type)
    [s, "stop-failure", ["push"], toErrorK("crashed")],
    [s, "crashed", ["push"], toErrorK("crashed")],
    [s, "interrupted", [], toErrorK("interrupted")],
    // running -> stopped (user stop): no push
    [s, "user-stop", [], (c) => {
      expect(c.phase).toBe("working");
      expect(c.workingSub).toBe("stopped");
      flagsCleared(c);
    }],
    [s, "cancel", ["archive-worktree"], toCancelled],
  );
}

// +input -> running (auto-reversal on prompt submit / native answer event)
for (const s of ["working.running+question", "working.running+permission", "working.running+silent"] as const) {
  LEGAL.push([s, "flag-clear", [], (c) => {
    toRunning(c, c);
    flagsCleared(c);
  }]);
}

// stopped/error rows: crash/interrupt re-assertion, cancel, requeue (drag map)
for (const s of ["working.stopped", "working.error(crashed)", "working.error(interrupted)"] as const) {
  LEGAL.push(
    [s, "crashed", ["push"], toErrorK("crashed")],
    [s, "interrupted", [], toErrorK("interrupted")],
    [s, "cancel", ["archive-worktree"], toCancelled],
    [s, "requeue", ["requeue-auto-off"], toRequeued],
  );
}

// error-only action row (spec 9.1): resume / restart / discard
for (const s of ["working.error(crashed)", "working.error(interrupted)"] as const) {
  LEGAL.push(
    [s, "resume", ["spawn-agent"], toStarting],
    [s, "restart", ["spawn-agent"], toStarting],
    [s, "discard", ["archive-worktree", "undo-toast"], toRequeued],
  );
}

// Task 11 keeps cross-column drag out of scope, so the existing resume route
// is also the recovery affordance for an explicitly stopped card.
LEGAL.push(["working.stopped", "resume", ["spawn-agent"], toStarting]);

// §7.3 manual arbitration is legal for every machine `working` shape. It
// changes only the derived input flag and preserves the lifecycle substate.
for (const s of [
  "working.starting", "working.running", "working.running+question",
  "working.running+permission", "working.running+silent", "working.stopped",
  "working.error(crashed)", "working.error(interrupted)",
] as const satisfies readonly StateName[]) {
  LEGAL.push(
    [s, "mark-state:running", [], (c, before) => {
      expect(c.phase).toBe("working");
      expect(c.workingSub).toBe(before.workingSub);
      flagsCleared(c);
    }],
    [s, "mark-state:needs-input", [], (c, before) => {
      expect(c.phase).toBe("working");
      expect(c.workingSub).toBe(before.workingSub);
      expect(c.inputKind).toBe("question");
      expect(c.inputSince).toBe(NOW);
    }],
  );
}

LEGAL.push(
  // review.ready -> running (cycle+1): send back
  ["review.ready", "send-back", [], (c, before) => {
    toRunning(c, before);
    expect(c.reviewSub).toBeNull();
    expect(c.round).toBe(before.round + 1);
  }],
  // ready -> merging -> done (merge is v0.2)
  ["review.ready", "merge-start", [], (c) => {
    expect(c.phase).toBe("review");
    expect(c.reviewSub).toBe("merging");
  }],
  ["review.ready", "cancel", ["archive-worktree"], toCancelled],
  ["review.merging", "merged", ["kill-sessions", "archive-worktree"], (c) => {
    expect(c.phase).toBe("done");
    expect(c.reviewSub).toBeNull();
    flagsCleared(c);
  }],
);

/** flag-clear on an unflagged working card: tolerated no-op, not illegal
 * (arbitration may double-clear; spec 6.1 tolerance). */
const NOOP_CLEAR = [
  "working.starting", "working.running", "working.stopped",
  "working.error(crashed)", "working.error(interrupted)",
] as const satisfies readonly StateName[];

// --- tests ------------------------------------------------------------------

test("spec 4.1 legal table: every row asserted with its effects", () => {
  expect(LEGAL.length).toBe(85); // state-changing legal rows (+5 no-op clears = 90 legal calls)
  for (const [from, evName, effects, check] of LEGAL) {
    const before = mk(STATES[from]);
    try {
      const out = transition(before, EVENTS[evName], NOW);
      expect(out.effects).toEqual(effects);
      check(out.card, before);
      expect(out.card.updatedAt).toBe(NOW); // updatedAt: now on every change
      CardSchema.parse(out.card); // machine never produces schema-illegal cards
      expect(before.updatedAt).toBe(T0); // input never mutated (also frozen)
    } catch (e) {
      throw new Error(`row [${from} x ${evName}]: ${e}`);
    }
  }
});

test("flag-clear on an unflagged working card is a tolerated no-op", () => {
  for (const from of NOOP_CLEAR) {
    const before = mk(STATES[from]);
    const out = transition(before, { t: "flag-clear" }, NOW);
    expect(out.card).toBe(before); // same reference: engine can skip the write
    expect(out.effects).toEqual([]);
    expect(out.card.updatedAt).toBe(T0); // a no-op is not a change
  }
});

test("illegal sweep: every remaining phase/sub x event pair throws", () => {
  const legal = new Set<string>([
    ...LEGAL.map(([s, e]) => `${s}|${e}`),
    ...NOOP_CLEAR.map((s) => `${s}|flag-clear`),
  ]);
  let swept = 0;
  for (const [stateName, patch] of Object.entries(STATES)) {
    for (const [evName, ev] of Object.entries(EVENTS)) {
      if (legal.has(`${stateName}|${evName}`)) continue;
      swept++;
      let thrown: unknown;
      try {
        transition(mk(patch), ev, NOW);
      } catch (e) {
        thrown = e;
      }
      if (!(thrown instanceof IllegalTransition)) {
        throw new Error(`[${stateName} x ${evName}]: expected IllegalTransition, got ${thrown === undefined ? "no throw" : String(thrown)}`);
      }
      expect(thrown.event).toBe(ev.t);
      expect(thrown.from.length).toBeGreaterThan(0);
    }
  }
  expect(swept).toBe(17 * 22 - 90); // 284 illegal pairs
});

test("illegal pairs throw (brief verbatim cases)", () => {
  for (const phase of ["queued", "review", "done", "cancelled"] as const) {
    const card = mk({ phase, reviewSub: phase === "review" ? "ready" : null });
    expect(() => transition(card, { t: "flag", kind: "silent" }, NOW)).toThrow(IllegalTransition);
  }
  expect(() => transition(mk({ phase: "done" }), { t: "complete" }, NOW)).toThrow(IllegalTransition);
  expect(() => transition(mk({ phase: "queued" }), { t: "merged" }, NOW)).toThrow(IllegalTransition);
});

test("flag while already flagged replaces the kind and refreshes inputSince", () => {
  const up = transition(mk(STATES["working.running+silent"]), { t: "flag", kind: "question" }, NOW);
  expect(up.card.inputKind).toBe("question");
  expect(up.card.inputSince).toBe(NOW); // refreshed from T0
  expect(up.effects).toEqual(["push"]); // upgrade to question pushes
  const down = transition(mk(STATES["working.running+question"]), { t: "flag", kind: "silent" }, NOW);
  expect(down.card.inputKind).toBe("silent");
  expect(down.effects).toEqual([]); // silent never pushes, even as a replacement
  const same = transition(mk(STATES["working.running+permission"]), { t: "flag", kind: "permission" }, NOW);
  expect(same.card.inputSince).toBe(NOW);
});

test("complete increments nothing; send-back increments round", () => {
  const done = transition(mk({ ...STATES["working.running"], round: 3 }), { t: "complete" }, NOW);
  expect(done.card.round).toBe(3);
  const back = transition(mk({ ...STATES["review.ready"], round: 3 }), { t: "send-back" }, NOW);
  expect(back.card.round).toBe(4);
});

test("start-failed keeps phase queued; start retries and clears the error", () => {
  const failed = transition(mk(STATES["working.starting"]), { t: "start-failed" }, NOW);
  expect(failed.card.phase).toBe("queued");
  expect(failed.card.errorKind).toBe("start_failed");
  const retried = transition(failed.card, { t: "start" }, NOW + 1);
  expect(retried.card.workingSub).toBe("starting");
  expect(retried.card.errorKind).toBeNull();
});

test("requeue and discard force auto:false from auto:true", () => {
  const rq = transition(mk({ ...STATES["working.stopped"], auto: true }), { t: "requeue" }, NOW);
  expect(rq.card.auto).toBe(false);
  expect(rq.effects).toEqual(["requeue-auto-off"]);
  const dc = transition(mk({ ...STATES["working.error(crashed)"], auto: true }), { t: "discard" }, NOW);
  expect(dc.card.auto).toBe(false);
  expect(dc.effects).toEqual(["archive-worktree", "undo-toast"]);
});

test("IllegalTransition carries only the from-summary and event name", () => {
  let err: IllegalTransition | undefined;
  try {
    transition(mk({ phase: "queued" }), { t: "merged" }, NOW);
  } catch (e) {
    err = e as IllegalTransition;
  }
  expect(err).toBeInstanceOf(IllegalTransition);
  expect(err!.name).toBe("IllegalTransition");
  expect(err!.from).toBe("queued");
  expect(err!.event).toBe("merged");
  expect(err!.message).toBe("queued -> merged"); // no free prose
  try {
    transition(mk(STATES["working.error(interrupted)"]), { t: "complete" }, NOW);
  } catch (e) {
    err = e as IllegalTransition;
  }
  expect(err!.from).toBe("working.error(interrupted)");
  try {
    transition(mk(STATES["working.running+question"]), { t: "merged" }, NOW);
  } catch (e) {
    err = e as IllegalTransition;
  }
  expect(err!.from).toBe("working.running+question");
});

test("effects arrays are fresh per call", () => {
  const a = transition(mk({}), { t: "start" }, NOW);
  a.effects.push("push");
  const b = transition(mk({}), { t: "start" }, NOW);
  expect(b.effects).toEqual(["create-worktree", "spawn-agent"]);
});

test("effect dispatcher rejects a synthetic future effect instead of silently no-oping", () => {
  let thrown: unknown;
  try {
    dispatchEffect("future-effect" as Effect);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("unhandled machine effect: future-effect");
});
