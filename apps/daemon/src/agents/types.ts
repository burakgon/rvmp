import type {
  Attempt,
  Card,
  Dispatch,
  InputKind,
  Project,
  SessionMeta,
} from "@codegent/protocol";
import type { OpenSessionOpts } from "../pty/manager";
import type { DetectStateName } from "../detect/classifier";

/** Execution mode for a dispatch (spec §6): `auto` = the agent's native
 * sandbox, autonomous; `host` = YOLO on the real machine; `ask` = the agent's
 * own permission prompts, surfaced as `permission` input flags. */
export type AgentMode = "auto" | "host" | "ask";

export interface SpawnCtx {
  project: Project;
  card: Card;
  attempt: Attempt;
  dispatch: Dispatch;
  worktreePath: string;
  mode: AgentMode;
  /** Adapter-native session id captured from a previous run (spec §4.3
   * reconciliation); re-spawns must re-pass the same mode flags. */
  resumeSessionId?: string | null;
  /** Extra task-prompt paragraph (engine-authored — e.g. send-back review
   * comments for a dead-session resume). Sanitized and appended by the
   * adapter's prompt builder; never surfaces outside the agent's terminal. */
  extraPrompt?: string | null;
  /** Content-free signal sink owned by the spawning dispatch. The engine
   * injects this callback; universal adapters use it for PTY classification,
   * while hook-backed premium adapters keep using `onHook`. */
  emitSignal?: (signal: AdapterSignal) => void;
  /** Task-6's confirmed `gone` verdict re-enters the engine's existing PTY
   * crash path through this content-free callback (no synthetic signal). */
  reportProcessGone?: () => void;
}

/**
 * Content-free state signals — the ONLY thing a normalizer may produce.
 * §6.1 "can't leak what can't be represented": the type structurally has no
 * room for prompt text, tool output, or messages; a non-null
 * `adapterSessionId` is the agent CLI's own session uuid, carried solely for
 * resume bookkeeping (universal CLIs report null readiness).
 */
export type AdapterSignal =
  | { s: "session-started"; adapterSessionId: string | null }
  | { s: "flag"; kind: InputKind }
  | { s: "flag-clear" } // PostToolUse(AskUserQuestion) → native answer (contract doc §3)
  | { s: "complete-eval" } // Stop — engine checks pending task_complete (truth table)
  | { s: "stop-failure" };

/** Content-free classifier projection retained by one live dispatch. */
export interface DetectStateSnapshot {
  state: DetectStateName;
  since: number;
}

export type SpawnResult = {
  sessionMeta: SessionMeta;
  settingsDir: string;
  /** Universal sessions expose current detection without agent identity,
   * rule ids, or any terminal content. Premium adapters omit it. */
  latestDetectState?: () => DetectStateSnapshot | null;
  /** Reset adapter-local publication state when the same PTY receives a new
   * dispatch. This is content-free and must only run at a dispatch boundary. */
  resetDispatchState?: () => void;
  /** Re-anchor startup grace after an engine-injected follow-up is submitted. */
  markTaskSubmitted?: () => void;
};

/** One live PTY, as adapters need it: prompt injection + output-quiet gating. */
export interface AdapterPtySession {
  /** PTY child pid; terminal spawns make it the process-group leader too. */
  readonly pid: number;
  /** Present on real PTY sessions; optional so small adapter fakes can omit it. */
  readonly exited?: Promise<number>;
  write(data: Uint8Array | string): void;
  onData(cb: (b: Uint8Array) => void): () => void;
}

/** The slice of PtyManager adapters consume — structural, so tests fake it. */
export interface AdapterPtys {
  open(opts: OpenSessionOpts): SessionMeta;
  get(id: string): AdapterPtySession | undefined;
}

/**
 * The premium-tier translator between one agent CLI and the orchestrator:
 * `spawn` materializes per-dispatch config + PTY + task prompt, `onHook`
 * normalizes raw hook payloads into state-machine signals. T8's engine drives
 * both; the Claude Code and Codex adapters implement it.
 */
export interface AgentAdapter {
  /** Adapter family label. UniversalAdapter serves several card agent ids. */
  readonly agent: string;
  spawn(ctx: SpawnCtx): Promise<SpawnResult>;
  /** PURE — no IO, no store, no clock. Unknown events → [] (fail-open). */
  onHook(sessionId: string, event: unknown): AdapterSignal[];
}
