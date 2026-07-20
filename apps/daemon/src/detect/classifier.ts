import { evaluate, type Evaluation, type Manifest } from "./manifest";
import { manifestFor } from "./manifests";
import { OscScanner, classifyOsc, type OscClassification } from "./osc";
import {
  AgentTracker,
  foregroundAgent,
  type ForegroundAgentResult,
  type PsSnapshot,
} from "./process-tree";
import type { ScreenGrid } from "./types";

/** Herdr `src/pane/agent_detection.rs:12-13`; research §3. */
export const STARTUP_GRACE_MS = 3_000;
/** Herdr `src/pane/agent_detection.rs:5-6`; research §3. */
export const IDLE_CONFIRM_RECHECK_MS = 100;
/** Herdr `src/pane/agent_detection.rs:7`; research §3. */
export const IDLE_CONFIRMATIONS = 3;
/** Herdr `src/pane/agent_detection.rs:8-9`; research §3. */
export const IDLE_CONFIRM_CAP_MS = 700;
/** Herdr `src/pane/agent_detection.rs:10-11`; research §3. */
export const BLOCKER_REASSERT_MS = 800;
/** Orca `agent-status-types.ts:258`; research §2.1. */
export const HOOK_STATE_FRESH_MS = 30 * 60 * 1_000;

const PROCESS_EXIT_IDLE_SAMPLES = 2;

export type DetectStateName = "working" | "idle" | "blocked" | "gone" | "unknown";

/** Shared Task-6 output consumed by the Task-7 universal adapter. */
export interface DetectState {
  agent: string | null;
  state: DetectStateName;
  since: number;
  ruleId?: string;
}

interface ReceivedHookState {
  state: DetectStateName;
  receivedAt: number;
  stateStartedAt?: number;
  ruleId?: string;
}

interface TimestampedHookState {
  state: DetectStateName;
  at: number;
  since?: number;
  ruleId?: string;
}

/**
 * Hook authority always requires an explicit receipt timestamp for the
 * 30-minute cutoff. `stateStartedAt`/`since` describe state history and are
 * never interpreted as receipt time.
 */
export type HookState = ReceivedHookState | TimestampedHookState;
export type HookStateSource = HookState | null | (() => HookState | null);

export interface ClassifierOptions {
  agentHint?: string;
  clock: () => number;
  screenGrid: (bytes: Uint8Array) => ScreenGrid;
  hookState?: HookStateSource;
}

type CandidateSource =
  | "hook"
  | "osc"
  | "screen"
  | "screen-fallback"
  | "process"
  | "none";

interface Candidate {
  state: DetectStateName;
  source: CandidateSource;
  ruleId?: string;
}

interface PendingIdle {
  startedAt: number;
  lastConfirmationAt: number;
  confirmations: number;
  plainFallback: boolean;
}

interface ScreenEvidence {
  screen: Evaluation | null;
  withOsc: Evaluation | null;
}

/**
 * Content-free layered state arbiter.
 *
 * Precedence follows Herdr `terminal/state.rs:1485-1500`
 * (`recompute_effective_state`) and Orca's completion coordinator (§2.6): a
 * positive visible blocker, a fresh explicit report, OSC, process evidence,
 * then screen fallback. Screen-row quiescence is recorded only as a readiness
 * fact and is deliberately absent from `candidate()`.
 */
export class Classifier {
  private readonly clock: () => number;
  private readonly screenGrid: (bytes: Uint8Array) => ScreenGrid;
  private readonly hookState: HookStateSource;
  private readonly scanner = new OscScanner();
  private readonly tracker = new AgentTracker();
  private readonly manifests = new Map<string, Manifest | null>();

  private readonly agentHint: string | null;
  private identifiedAgent: string | null;
  private agentAppearedAt: number | null;
  private latestGrid: ScreenGrid | null = null;
  private lastSampledRows: readonly string[] | null = null;
  private screenStateQuiet = false;
  private nonShellForeground = false;
  private processObserved = false;
  private processGone = false;
  private processExitIdle = false;
  private processIdleVeto = false;
  private consecutiveProcessIdleObservations = 0;
  private pendingIdle: PendingIdle | null = null;
  private lastBlockerAssertedAt: number | null = null;
  private current: DetectState;

  constructor(options: ClassifierOptions) {
    this.clock = options.clock;
    this.screenGrid = options.screenGrid;
    this.hookState = options.hookState ?? null;
    this.agentHint = normalizeAgent(options.agentHint);
    this.identifiedAgent = this.agentHint;

    const now = this.clock();
    this.agentAppearedAt = this.agentHint === null ? null : now;
    this.current = {
      agent: this.agentHint,
      state: this.agentHint === null ? "unknown" : "idle",
      since: now,
    };

    // The daemon knows the label at spawn. Seed the presence hysteresis with
    // that fact so six later misses can still produce AgentTracker.gone even
    // when the first process probe happens after a very short-lived launch.
    if (this.agentHint !== null) {
      this.tracker.update({ agent: this.agentHint, pid: null });
    }
  }

  /** Feed the same PTY bytes to both Task 3's OSC scanner and Task 1's VT grid. */
  feed(bytes: Uint8Array): void {
    this.scanner.feed(bytes);
    const snapshot = this.screenGrid(bytes);
    this.latestGrid = {
      rows: [...snapshot.rows],
      // Task 3 is the single retained OSC authority in this class. Replacing
      // the grid's duplicate fields also lets clearOnAgentChange prevent stale
      // metadata from crossing foreground identities.
      oscTitle: this.scanner.title,
      oscProgress: this.scanner.progress,
    };
  }

  /** Update identity and presence from one injected process-table snapshot. */
  observe(shellPid: number, psSnapshot: PsSnapshot): void {
    const observedAt = this.clock();
    const foreground = foregroundAgent(shellPid, psSnapshot);
    const hasDescendants = snapshotHasDescendants(shellPid, psSnapshot);

    this.processObserved = true;
    this.nonShellForeground = foreground.pid !== null;
    this.processExitIdle = foreground.agent === null && !hasDescendants;
    // `docs/research/orca-agent-state.md` §2.6 requires two distinct process
    // inspections plus the no-child veto before accepting a transient shell
    // result as idle. Sampling cannot advance this counter, and any contrary
    // process observation restarts the sequence.
    this.consecutiveProcessIdleObservations = this.processExitIdle
      ? Math.min(
          this.consecutiveProcessIdleObservations + 1,
          PROCESS_EXIT_IDLE_SAMPLES,
        )
      : 0;
    // Orca §2.6, lines 506-560: shell/null foreground is not an exit while
    // any child remains. `generic` is deliberately unrecognized for this veto.
    this.processIdleVeto =
      hasDescendants && (foreground.agent === null || foreground.agent === "generic");

    const trackerInput = this.trackerInput(foreground);
    const tracked = this.tracker.update(trackerInput);

    if (tracked.gone) {
      this.identifiedAgent = null;
      this.agentAppearedAt = null;
      this.processGone = true;
      this.clearPendingIdle();
      this.scanner.clearOnAgentChange();
      return;
    }

    if (tracked.agent === null) return;

    this.processGone = false;
    const refined = normalizeAgent(tracked.agent);
    if (refined === null || refined === this.identifiedAgent) return;

    this.identifiedAgent = refined;
    this.agentAppearedAt = observedAt;
    this.clearPendingIdle();
    // Herdr `pane.rs:722-724`: retained OSC belongs to the foreground agent
    // that emitted it and must be discarded when process identity changes.
    this.scanner.clearOnAgentChange();
  }

  sample(now: number): DetectState {
    this.observeScreenReadiness();

    const outputAgent = this.identifiedAgent ?? this.current.agent;
    const evidenceAgent = this.identifiedAgent ?? this.current.agent;
    const evidence = this.screenEvidence(evidenceAgent);

    // Herdr recompute_effective_state precedence #1. Evaluate without OSC so
    // a higher-priority working title cannot conceal a rendered permission UI.
    // `skip_state_update` is the sole exception and freezes the entire prior
    // DetectState, including identity, timestamp, and rule id.
    if (evidence.screen !== null && "freeze" in evidence.screen) return this.current;
    if (evidence.screen?.state === "blocked") {
      this.resetIdleConfirmation();
      return this.publishBlocked(outputAgent, evidence.screen.ruleId, now);
    }

    const screenWorking =
      evidence.screen?.state === "working" && evidence.screen.fallback === false;
    const osc = classifyOsc(this.scanner.title, this.scanner.progress);
    const volunteeredWorking = osc === "working" || screenWorking;

    // Orca coordinator lines 730-752: a volunteered title/screen working
    // signal cancels provisional idle/done, even when the pending candidate
    // originated from a higher hook layer.
    if (volunteeredWorking) this.resetIdleConfirmation();

    const hook = this.freshHook(now);
    if (hook !== null && !(hook.state === "idle" && volunteeredWorking)) {
      return this.coordinate(
        outputAgent,
        candidate(hook.state, "hook", hook.ruleId),
        now,
      );
    }

    // AgentTracker's confirmed gone verdict is authoritative once no fresh
    // hook remains. Visible blockers were handled above and OSC was cleared at
    // the identity transition, so stale terminal metadata cannot mask exit.
    if (this.processGone) {
      this.resetIdleConfirmation();
      return this.publish(null, candidate("gone", "process"), now);
    }

    // Herdr suspends screen/OSC judgment for three seconds after an agent
    // appears (`pane.rs:726-773`) and publishes Idle during that grace. Fresh
    // hooks and positive blockers above remain safety authorities.
    if (
      this.agentAppearedAt !== null &&
      now - this.agentAppearedAt < STARTUP_GRACE_MS
    ) {
      this.clearPendingIdle();
      return this.publish(outputAgent, candidate("idle", "process"), now);
    }

    if (osc !== null) {
      return this.coordinate(
        outputAgent,
        candidate(osc, "osc", matchingOscRuleId(osc, evidence.withOsc)),
        now,
      );
    }

    if (screenWorking && evidence.screen !== null) {
      return this.coordinate(
        outputAgent,
        candidate("working", "screen", evidence.screen.ruleId),
        now,
      );
    }

    // Orca §2.6's process-exit path requires a repeated shell/no-child sample
    // before idle. AgentTracker's later six-miss verdict advances it to gone.
    if (this.processExitIdle && outputAgent !== null) {
      const idleRuleId =
        evidence.screen?.state === "idle" ? evidence.screen.ruleId : undefined;
      return this.coordinate(
        outputAgent,
        candidate("idle", "process", idleRuleId),
        now,
      );
    }

    if (evidence.screen !== null) {
      const source = evidence.screen.fallback ? "screen-fallback" : "screen";
      return this.coordinate(
        outputAgent,
        candidate(evidence.screen.state, source, evidence.screen.ruleId),
        now,
      );
    }

    if (this.processObserved && this.nonShellForeground && outputAgent !== null) {
      this.resetIdleConfirmation();
      return this.publish(outputAgent, candidate("working", "process"), now);
    }

    // The spawn hint is identity evidence, not an idle report. Preserve the
    // last classified value when no layer has anything newer; hook silence and
    // byte silence therefore cannot synthesize idle.
    this.clearPendingIdle();
    if (outputAgent === this.current.agent) return this.current;
    return this.publish(outputAgent, candidate("unknown", "none"), now);
  }

  private trackerInput(foreground: ForegroundAgentResult): ForegroundAgentResult {
    // A generic argv match cannot improve on the daemon's spawn-time label.
    // Specific registry/env evidence still refines a stale or broad hint.
    const knownAgent = this.identifiedAgent ?? this.agentHint;
    if (foreground.agent === "generic" && knownAgent !== null) {
      return { agent: knownAgent, pid: foreground.pid };
    }
    return foreground;
  }

  private screenEvidence(agent: string | null): ScreenEvidence {
    if (agent === null || this.latestGrid === null) return { screen: null, withOsc: null };
    const manifest = this.manifest(agent);
    if (manifest === null) return { screen: null, withOsc: null };

    const screenGrid: ScreenGrid = {
      rows: this.latestGrid.rows,
      oscTitle: null,
      oscProgress: null,
    };
    const withOsc: ScreenGrid = {
      rows: this.latestGrid.rows,
      oscTitle: this.scanner.title,
      oscProgress: this.scanner.progress,
    };
    return {
      screen: evaluate(manifest, screenGrid),
      withOsc: evaluate(manifest, withOsc),
    };
  }

  private manifest(agent: string): Manifest | null {
    if (this.manifests.has(agent)) return this.manifests.get(agent) ?? null;
    const manifest = manifestFor(agent);
    this.manifests.set(agent, manifest);
    return manifest;
  }

  private freshHook(now: number): HookState | null {
    const value = typeof this.hookState === "function" ? this.hookState() : this.hookState;
    if (value === null) return null;

    const receivedAt = hookReceivedAt(value);
    if (!Number.isFinite(receivedAt) || receivedAt > now) return null;
    if (now - receivedAt > HOOK_STATE_FRESH_MS) return null;
    return value;
  }

  private coordinate(agent: string | null, next: Candidate, now: number): DetectState {
    if (next.state !== "idle") {
      this.resetIdleConfirmation();
      return this.publish(agent, next, now);
    }
    if (this.current.state === "idle") {
      this.clearPendingIdle();
      return this.publish(agent, next, now);
    }

    // Orca coordinator lines 506-560: a null/shell foreground observation is
    // not an idle sample while any descendant survives.
    if (this.processIdleVeto) {
      this.clearPendingIdle();
      return this.current;
    }

    const plainFallback = next.source === "screen-fallback";
    if (this.pendingIdle === null || this.pendingIdle.plainFallback !== plainFallback) {
      this.pendingIdle = {
        startedAt: now,
        lastConfirmationAt: now,
        confirmations: 0,
        plainFallback,
      };
      if (plainFallback) return this.current;
    }

    const pending = this.pendingIdle;

    if (plainFallback) {
      // Herdr `PendingIdleConfirmation::should_hold_working_to_idle`, lines
      // 39-77: plain Working→Idle waits for three 100ms confirmations, with a
      // hard 700ms cap. Visible/explicit idle still keeps Orca's two samples.
      if (now - pending.startedAt >= IDLE_CONFIRM_CAP_MS) {
        this.clearPendingIdle();
        return this.publish(agent, next, now);
      }
      if (now - pending.lastConfirmationAt >= IDLE_CONFIRM_RECHECK_MS) {
        pending.confirmations += 1;
        pending.lastConfirmationAt = now;
      }
      if (pending.confirmations < IDLE_CONFIRMATIONS) return this.current;
    } else if (
      this.consecutiveProcessIdleObservations < PROCESS_EXIT_IDLE_SAMPLES
    ) {
      return this.current;
    }

    this.clearPendingIdle();
    return this.publish(agent, next, now);
  }

  private publishBlocked(agent: string | null, ruleId: string, now: number): DetectState {
    // Object identity is the publication token for the Task-7 event bridge:
    // stable blockers return the same DetectState until Herdr's 800ms refresh
    // is due, then re-publish an equal state without corrupting `since`.
    const refreshDue =
      this.lastBlockerAssertedAt === null ||
      now - this.lastBlockerAssertedAt >= BLOCKER_REASSERT_MS;
    if (refreshDue) {
      this.lastBlockerAssertedAt = now;
    }

    const previous = this.current;
    const published = this.publish(agent, candidate("blocked", "screen", ruleId), now);
    if (!refreshDue || published !== previous) return published;

    this.current = stateWithRule(agent, "blocked", published.since, ruleId);
    return this.current;
  }

  private publish(agent: string | null, next: Candidate, now: number): DetectState {
    if (next.state !== "blocked") this.lastBlockerAssertedAt = null;

    const sameState = this.current.agent === agent && this.current.state === next.state;
    const sameRule = this.current.ruleId === next.ruleId;
    if (sameState && sameRule) return this.current;

    const since = sameState ? this.current.since : now;
    this.current = stateWithRule(agent, next.state, since, next.ruleId);
    return this.current;
  }

  private observeScreenReadiness(): void {
    if (this.latestGrid === null) {
      this.screenStateQuiet = false;
      return;
    }

    const rows = this.latestGrid.rows;
    this.screenStateQuiet =
      this.lastSampledRows !== null && equalRows(rows, this.lastSampledRows);
    this.lastSampledRows = [...rows];

    // Deliberate banned-path lock: `screenStateQuiet && nonShellForeground` is
    // only a readiness fact. Neither value is consulted by candidate(). Raw
    // byte activity is not retained at all (Herdr research §3c; Orca §2.5).
    void (this.screenStateQuiet && this.nonShellForeground);
  }

  private clearPendingIdle(): void {
    this.pendingIdle = null;
  }

  private resetIdleConfirmation(): void {
    this.clearPendingIdle();
    this.consecutiveProcessIdleObservations = 0;
  }
}

function candidate(
  state: DetectStateName,
  source: CandidateSource,
  ruleId?: string,
): Candidate {
  return ruleId === undefined ? { state, source } : { state, source, ruleId };
}

function stateWithRule(
  agent: string | null,
  state: DetectStateName,
  since: number,
  ruleId?: string,
): DetectState {
  return ruleId === undefined ? { agent, state, since } : { agent, state, since, ruleId };
}

function normalizeAgent(agent: string | undefined | null): string | null {
  const normalized = agent?.trim().toLowerCase() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function hookReceivedAt(hook: HookState): number {
  if ("receivedAt" in hook) return hook.receivedAt;
  return hook.at;
}

function matchingOscRuleId(
  state: OscClassification,
  evaluation: Evaluation | null,
): string | undefined {
  if (evaluation === null || "freeze" in evaluation) return undefined;
  if (evaluation.fallback || evaluation.state !== state) return undefined;
  return evaluation.ruleId;
}

function equalRows(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => row === right[index]);
}

function snapshotHasDescendants(shellPid: number, snapshot: PsSnapshot): boolean {
  if (!Number.isInteger(shellPid) || shellPid <= 1) return false;
  // Every rooted descendant tree begins with a direct child. This remains
  // cycle-safe for malformed injected snapshots and is all Orca's veto needs.
  return snapshot.some((process) => process.ppid === shellPid && process.pid !== shellPid);
}
