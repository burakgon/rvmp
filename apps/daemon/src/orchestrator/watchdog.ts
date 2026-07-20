import type { DomainEvent, InputKind, MarkState } from "@codegent/protocol";
import type { DetectStateSnapshot } from "../agents/types";

/**
 * Spec §9.2 requires a persistent mismatch threshold but does not assign N.
 * One 30-second supervision pulse is the smallest documented default that
 * shares the engine's existing cadence while filtering transient classifier
 * flips. Tests inject a shorter threshold; production keeps this value.
 */
export const DEFAULT_MISMATCH_THRESHOLD_MS = 30_000;

export interface ManualOverride {
  state: MarkState;
  since: number;
}

/** The latest adapter intent hidden by a sticky manual override. Its entire
 * vocabulary is content-free: an InputKind enum or the flag-clear enum. */
export interface SuppressedAdapterIntent {
  intent: InputKind | "flag-clear";
  since: number;
}

export interface WatchdogObservation {
  cardId: number;
  manual: ManualOverride | null;
  detected: DetectStateSnapshot | null;
  suppressed?: SuppressedAdapterIntent | null;
}

type MismatchNotice = Extract<DomainEvent, { t: "notice" }> & { kind: "mismatch" };
type MismatchClear = Extract<DomainEvent, { t: "notice-clear" }>;
type MismatchEvent = MismatchNotice | MismatchClear;

interface WatchdogOptions {
  clock: () => number;
  emit: (event: MismatchEvent) => void;
  thresholdMs?: number;
}

type MismatchSource =
  | { kind: "detected"; state: DetectStateSnapshot["state"]; since: number }
  | { kind: "suppressed"; intent: SuppressedAdapterIntent["intent"]; since: number };

interface Mismatch {
  manual: MarkState;
  manualSince: number;
  source: MismatchSource;
  since: number;
}

interface Latch extends Mismatch {
  emitted: boolean;
}

/**
 * Cross-checks sticky human state against live content-free detection. It is
 * observational only: a mismatch emits one enum-only notice plus a paired
 * enum-only clear when it resolves, and never changes the card or classifier.
 */
export class Watchdog {
  readonly thresholdMs: number;
  private readonly latches = new Map<number, Latch>();

  constructor(private readonly options: WatchdogOptions) {
    this.thresholdMs = options.thresholdMs ?? DEFAULT_MISMATCH_THRESHOLD_MS;
  }

  tick(observations: readonly WatchdogObservation[]): void {
    const observed = new Set<number>();
    const now = this.options.clock();

    for (const observation of observations) {
      observed.add(observation.cardId);
      const mismatch = disagreement(observation);
      if (mismatch === null) {
        this.drop(observation.cardId);
        continue;
      }

      let latch = this.latches.get(observation.cardId);
      if (!latch || !sameMismatch(latch, mismatch)) {
        latch = {
          ...mismatch,
          // Neither side can disagree before its current state began.
          emitted: false,
        };
        this.latches.set(observation.cardId, latch);
      }

      if (!latch.emitted && now - latch.since > this.thresholdMs) {
        latch.emitted = true;
        this.options.emit({ t: "notice", cardId: observation.cardId, kind: "mismatch" });
      }
    }

    // Omitted cards are no longer active; a later active lifetime starts with
    // a fresh latch even if ids and enums happen to match.
    for (const cardId of this.latches.keys()) {
      if (!observed.has(cardId)) this.drop(cardId);
    }
  }

  clear(cardId: number): void {
    this.drop(cardId);
  }

  private drop(cardId: number): void {
    const latch = this.latches.get(cardId);
    if (!latch) return;
    this.latches.delete(cardId);
    if (latch.emitted) {
      this.options.emit({ t: "notice-clear", cardId, kind: "mismatch" });
    }
  }
}

function disagreement(observation: WatchdogObservation): Mismatch | null {
  const { manual, suppressed = null, detected } = observation;
  if (manual === null) return null;

  // A suppressed adapter intent is the uniform source for premium and
  // universal tiers. It takes precedence over a possibly older classifier
  // snapshot because it is the latest normalized intent the engine received.
  if (suppressed !== null) {
    const disagrees = manual.state === "running"
      ? suppressed.intent !== "flag-clear"
      : suppressed.intent === "flag-clear";
    return disagrees
      ? {
          manual: manual.state,
          manualSince: manual.since,
          source: { kind: "suppressed", intent: suppressed.intent, since: suppressed.since },
          since: Math.max(manual.since, suppressed.since),
        }
      : null;
  }

  if (detected === null || !disagrees(manual.state, detected.state)) return null;
  return {
    manual: manual.state,
    manualSince: manual.since,
    source: { kind: "detected", state: detected.state, since: detected.since },
    since: Math.max(manual.since, detected.since),
  };
}

function sameMismatch(a: Mismatch, b: Mismatch): boolean {
  if (a.manual !== b.manual || a.manualSince !== b.manualSince) return false;
  if (a.source.kind !== b.source.kind) return false;
  // Suppressed permission/question/silent intents all mean the same direction
  // of disagreement with manual running (and flag-clear is the same inverse
  // disagreement with manual needs-input). Their sub-kind/timestamp may change
  // while attention is continuously suppressed; keep the existing emit latch.
  if (a.source.kind === "suppressed" && b.source.kind === "suppressed") return true;
  if (a.source.since !== b.source.since) return false;
  return a.source.kind === "detected" && b.source.kind === "detected"
    && a.source.state === b.source.state;
}

function disagrees(manual: MarkState, detected: DetectStateSnapshot["state"]): boolean {
  return (manual === "running"
      && (detected === "blocked" || detected === "idle" || detected === "unknown"))
    || (manual === "needs-input" && detected === "working");
}
