import type { Card, InputKind, MarkState } from "@codegent/protocol";

/**
 * Pure card state machine — the single authority on legal card transitions
 * (spec 4.1). The orchestrator engine and recovery routes drive it; it never
 * touches the store, the clock, or any IO. `now` is the caller's clock.
 *
 * v0.2 rows (spec 4.1 "Key transitions" + completion truth table + drag map):
 *
 *   from                    event            to                        effects
 *   queued[+start_failed]   start            working.starting          create-worktree, spawn-agent
 *   working.starting        session-started  working.running           -
 *   working.starting        start-failed     queued + start_failed     archive-worktree (partial rollback; no push)
 *   working.running[+flag]  flag(kind)       same + flag replaced      push (question/permission only; silent never)
 *   working.<any>+flag      flag-clear       flag cleared              -      (unflagged working: tolerated no-op)
 *   working.<any>           mark-state       manual flag set/cleared   -
 *   working.running[+flag]  complete         review.ready              compute-diffstat, push
 *   working.running[+flag]  stop-failure     working.error(crashed)    push
 *   working.<any sub>       crashed          working.error(crashed)    push
 *   working.<any sub>       interrupted      working.error(interrupted) -
 *   working.running[+flag]  user-stop        working.stopped           -
 *   review.ready            send-back        working.running, round+1  -
 *   review.ready            merge-start      review.merging            -
 *   review.merging          merged           done                      kill-sessions, archive-worktree
 *   review.ready|stale      base-advanced    review.stale              -
 *   review.stale            update-start     review.updating           -
 *   review.updating         update-result    review.ready|conflict     -
 *   review.conflict         conflict-resolved review.ready             -
 *   review.<any>            external-merged  done                      kill-sessions, archive-worktree
 *   working.<any>|rev.ready cancel           cancelled                 archive-worktree
 *   working.stopped|error   requeue          queued, auto:false        requeue-auto-off (worktree kept)
 *   working.stopped|error   resume           working.starting          spawn-agent (same worktree)
 *   working.error           restart          working.starting          spawn-agent (same worktree)
 *   working.error           discard          queued, auto:false        archive-worktree, undo-toast
 */
export type MachineEvent =
  | { t: "start" }
  | { t: "session-started" }
  | { t: "start-failed" }
  | { t: "flag"; kind: InputKind }
  | { t: "flag-clear" }
  | { t: "mark-state"; state: MarkState }
  | { t: "complete" }
  | { t: "stop-failure" }
  | { t: "crashed" }
  | { t: "interrupted" }
  | { t: "user-stop" }
  | { t: "send-back" }
  | { t: "merge-start" }
  | { t: "merged" }
  | { t: "cancel" }
  | { t: "requeue" }
  | { t: "resume" }
  | { t: "restart" }
  | { t: "discard" }
  | { t: "base-advanced"; behind: number }
  | { t: "update-start" }
  | { t: "update-result"; ok: boolean }
  | { t: "conflict-resolved" }
  | { t: "external-merged" };

export type Effect =
  | "create-worktree"
  | "spawn-agent"
  | "kill-sessions"
  | "archive-worktree"
  | "compute-diffstat"
  | "push"
  | "undo-toast"
  | "requeue-auto-off";

const unhandledEffect = (effect: never): never => {
  throw new Error(`unhandled machine effect: ${String(effect)}`);
};

/** Runtime half of the effect-interpreter totality contract. The explicit
 * switch makes widening Effect a compile error at the never call, while the
 * default also catches untyped/corrupt values at runtime. Engine wraps every
 * transition result with this dispatcher before interpreting it per-call-site. */
export function dispatchEffect(effect: Effect): void {
  switch (effect) {
    case "create-worktree":
    case "spawn-agent":
    case "kill-sessions":
    case "archive-worktree":
    case "compute-diffstat":
    case "push":
    case "undo-toast":
    case "requeue-auto-off":
      return;
    default:
      return unhandledEffect(effect);
  }
}

/** Carries only a structural from-summary and the event name — no free prose. */
export class IllegalTransition extends Error {
  readonly from: string;
  readonly event: MachineEvent["t"];
  constructor(from: string, event: MachineEvent["t"]) {
    super(`${from} -> ${event}`);
    this.name = "IllegalTransition";
    this.from = from;
    this.event = event;
  }
}

/** Structural state summary, e.g. "queued+start_failed", "working.running+question",
 * "working.error(crashed)", "review.ready". */
function summarize(c: Card): string {
  switch (c.phase) {
    case "queued":
      return c.errorKind ? `queued+${c.errorKind}` : "queued";
    case "working": {
      const sub = c.workingSub === "error" ? `error(${c.errorKind})` : String(c.workingSub);
      return `working.${sub}${c.inputKind ? `+${c.inputKind}` : ""}`;
    }
    case "review":
      return `review.${String(c.reviewSub)}`;
    default:
      return c.phase;
  }
}

const toError = (c: Card, kind: "crashed" | "interrupted", now: number): Card => ({
  ...c, workingSub: "error", errorKind: kind,
  inputKind: null, inputSince: null, updatedAt: now,
});

const toQueuedAutoOff = (c: Card, now: number): Card => ({
  ...c, phase: "queued", workingSub: null, errorKind: null,
  inputKind: null, inputSince: null, auto: false, updatedAt: now,
});

export function transition(card: Card, ev: MachineEvent, now: number): { card: Card; effects: Effect[] } {
  const fail = () => new IllegalTransition(summarize(card), ev.t);
  const working = card.phase === "working";
  const starting = working && card.workingSub === "starting";
  const running = working && card.workingSub === "running";
  const stopped = working && card.workingSub === "stopped";
  const inError = working && card.workingSub === "error";
  const reviewReady = card.phase === "review" && card.reviewSub === "ready";
  const reviewStale = card.phase === "review" && card.reviewSub === "stale";
  const reviewUpdating = card.phase === "review" && card.reviewSub === "updating";
  const reviewConflict = card.phase === "review" && card.reviewSub === "conflict";
  const inReviewSub = card.phase === "review" && card.reviewSub !== null;

  switch (ev.t) {
    case "start": {
      if (card.phase !== "queued") throw fail();
      return {
        card: {
          ...card, phase: "working", workingSub: "starting", errorKind: null,
          reviewSub: null, inputKind: null, inputSince: null, updatedAt: now,
        },
        effects: ["create-worktree", "spawn-agent"],
      };
    }
    case "session-started": {
      if (!starting) throw fail();
      return { card: { ...card, workingSub: "running", updatedAt: now }, effects: [] };
    }
    case "start-failed": {
      if (!starting) throw fail();
      return {
        card: { ...card, phase: "queued", workingSub: null, errorKind: "start_failed", updatedAt: now },
        effects: ["archive-worktree"],
      };
    }
    case "flag": {
      if (!running) throw fail();
      return {
        card: { ...card, inputKind: ev.kind, inputSince: now, updatedAt: now },
        effects: ev.kind === "silent" ? [] : ["push"],
      };
    }
    case "flag-clear": {
      if (!working) throw fail();
      if (card.inputKind === null) return { card, effects: [] }; // tolerated double-clear (spec 6.1)
      return { card: { ...card, inputKind: null, inputSince: null, updatedAt: now }, effects: [] };
    }
    case "mark-state": {
      if (!working) throw fail();
      // `question` is the existing generic needs-input kind. A manual mark is
      // informational state arbitration, not a new push-notification source.
      return ev.state === "needs-input"
        ? {
            card: { ...card, inputKind: "question", inputSince: now, updatedAt: now },
            effects: [],
          }
        : {
            card: { ...card, inputKind: null, inputSince: null, updatedAt: now },
            effects: [],
          };
    }
    case "complete": {
      if (!running) throw fail();
      return {
        card: {
          ...card, phase: "review", workingSub: null, errorKind: null,
          reviewSub: "ready", inputKind: null, inputSince: null,
          readySince: now, updatedAt: now,
        },
        effects: ["compute-diffstat", "push"],
      };
    }
    case "stop-failure": {
      if (!running) throw fail();
      return { card: toError(card, "crashed", now), effects: ["push"] };
    }
    case "crashed": {
      if (!working) throw fail();
      return { card: toError(card, "crashed", now), effects: ["push"] };
    }
    case "interrupted": {
      if (!working) throw fail();
      return { card: toError(card, "interrupted", now), effects: [] };
    }
    case "user-stop": {
      if (!running) throw fail();
      return {
        card: { ...card, workingSub: "stopped", errorKind: null, inputKind: null, inputSince: null, updatedAt: now },
        effects: [],
      };
    }
    case "send-back": {
      if (!reviewReady) throw fail();
      return {
        card: {
          ...card, phase: "working", workingSub: "running", reviewSub: null,
          readySince: null, round: card.round + 1, updatedAt: now,
        },
        effects: [],
      };
    }
    case "merge-start": {
      if (!reviewReady) throw fail();
      return { card: { ...card, reviewSub: "merging", updatedAt: now }, effects: [] };
    }
    case "merged": {
      if (!(card.phase === "review" && card.reviewSub === "merging")) throw fail();
      return {
        card: { ...card, phase: "done", reviewSub: null, readySince: null, updatedAt: now },
        effects: ["kill-sessions", "archive-worktree"],
      };
    }
    case "base-advanced": {
      if (!(reviewReady || reviewStale)) throw fail();
      return { card: { ...card, reviewSub: "stale", updatedAt: now }, effects: [] };
    }
    case "update-start": {
      if (!reviewStale) throw fail();
      return { card: { ...card, reviewSub: "updating", updatedAt: now }, effects: [] };
    }
    case "update-result": {
      if (!reviewUpdating) throw fail();
      return {
        card: { ...card, reviewSub: ev.ok ? "ready" : "conflict", updatedAt: now },
        effects: [],
      };
    }
    case "conflict-resolved": {
      if (!reviewConflict) throw fail();
      return { card: { ...card, reviewSub: "ready", updatedAt: now }, effects: [] };
    }
    case "external-merged": {
      if (!inReviewSub) throw fail();
      return {
        card: { ...card, phase: "done", reviewSub: null, readySince: null, updatedAt: now },
        effects: ["kill-sessions", "archive-worktree"],
      };
    }
    case "cancel": {
      // Review cards are cancellable from ready/stale/conflict (close-without-
      // merge is a legitimate exit); updating/merging stay illegal — a rebase
      // or merge is mid-flight and must land in a truthful state first (the
      // conflict poll converts a crashed update into conflict, which cancels).
      const reviewCancellable = card.phase === "review"
        && (card.reviewSub === "ready" || card.reviewSub === "stale" || card.reviewSub === "conflict");
      if (!(working || reviewCancellable)) throw fail();
      return {
        card: {
          ...card, phase: "cancelled", workingSub: null, errorKind: null,
          reviewSub: null, inputKind: null, inputSince: null,
          readySince: null, updatedAt: now,
        },
        effects: ["archive-worktree"],
      };
    }
    case "requeue": {
      if (!(stopped || inError)) throw fail();
      return { card: toQueuedAutoOff(card, now), effects: ["requeue-auto-off"] };
    }
    case "resume": {
      if (!(inError || stopped)) throw fail();
      return {
        card: { ...card, workingSub: "starting", errorKind: null, updatedAt: now },
        effects: ["spawn-agent"],
      };
    }
    case "restart": {
      if (!inError) throw fail();
      return {
        card: { ...card, workingSub: "starting", errorKind: null, updatedAt: now },
        effects: ["spawn-agent"],
      };
    }
    case "discard": {
      if (!inError) throw fail();
      return { card: toQueuedAutoOff(card, now), effects: ["archive-worktree", "undo-toast"] };
    }
  }
}
