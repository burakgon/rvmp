import type { Attempt, Card, Dispatch, Project, SessionMeta } from "@codegent/protocol";
import type { OpenSessionOpts } from "../pty/manager";

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
}

/**
 * Content-free state signals — the ONLY thing a normalizer may produce.
 * §6.1 "can't leak what can't be represented": the type structurally has no
 * room for prompt text, tool output, or messages; `adapterSessionId` is the
 * agent CLI's own session uuid, carried solely for resume bookkeeping.
 */
export type AdapterSignal =
  | { s: "session-started"; adapterSessionId: string }
  | { s: "flag"; kind: "question" | "permission" }
  | { s: "flag-clear" } // PostToolUse(AskUserQuestion) → native answer (contract doc §3)
  | { s: "complete-eval" } // Stop — engine checks pending task_complete (truth table)
  | { s: "stop-failure" };

export type SpawnResult = { sessionMeta: SessionMeta; settingsDir: string };

/** One live PTY, as adapters need it: prompt injection + output-quiet gating. */
export interface AdapterPtySession {
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
  agent: "claude" | "codex";
  spawn(ctx: SpawnCtx): Promise<SpawnResult>;
  /** PURE — no IO, no store, no clock. Unknown events → [] (fail-open). */
  onHook(sessionId: string, event: unknown): AdapterSignal[];
}
