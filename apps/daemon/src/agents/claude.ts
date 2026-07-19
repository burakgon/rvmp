import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubAgentEnv } from "../pty/session";
import type { PtyManager } from "../pty/manager";
import { writeHookScript } from "./receiver";
import type {
  AdapterPtySession, AdapterPtys, AdapterSignal, AgentAdapter, SpawnCtx, SpawnResult,
} from "./types";

// Compile-time proof that the real PtyManager satisfies the structural slice
// the adapter consumes (tests substitute fakes through the same seam).
const _ptyManagerIsAdapterPtys = (m: PtyManager): AdapterPtys => m;
void _ptyManagerIsAdapterPtys;

/**
 * Claude Code adapter — every shape below is the RECORDED WORKING CONFIG from
 * the live spike against claude 2.1.215 (docs/research/cc-codex-hook-contract.md,
 * captures in docs/research/tmp/cc-hook-spike/, canonical trimmed payloads in
 * test/fixtures/cc-hooks/). Where the plan sketch and the contract doc differ,
 * the contract doc wins.
 */

/** The six verified hook events — Notification is deliberately absent
 * (contract doc claim 4: a +6s/+60s delayed derivative, redundant). */
const HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "StopFailure"] as const;

/** Injection timing. `capMs`/`quietMs` gate the paste on output-quiet (§6.1
 * layer 4: quiescence is a readiness gate only); `enterDelayMs` is the
 * paste→Enter gap — Orca-proven: CC treats large writes as paste and swallows
 * an embedded `\r`, so the submit must travel alone (orca-agent-state §6). */
export interface InjectTiming {
  capMs: number;
  quietMs: number;
  enterDelayMs: number;
}
export const DEFAULT_INJECT_TIMING: InjectTiming = { capMs: 3000, quietMs: 250, enterDelayMs: 500 };

export interface ClaudeAdapterDeps {
  dataDir: string;
  /** Signal-plane endpoint (T6 receiver) — baked into the sidecar's mcp.json. */
  hookPort: number;
  hookToken: string;
  ptys: AdapterPtys;
  timing?: Partial<InjectTiming>;
}

/** POSIX single-quote, safe for paths/ids embedded in a hook command string. */
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Normalize newlines, strip every other C0 control + DEL (incl. ESC) — the
 * composed prompt must never carry a stray `\r` (premature submit) or escape
 * sequences (terminal control breakout inside the composer). */
const sanitizePromptText = (s: string): string =>
  s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/**
 * The task prompt written into the composer: card title + body + the MCP
 * usage contract + dispatch envelope ids. English, content-only — and the
 * §6.1 preamble rule verbatim: report completion exactly once, even on failure.
 */
export function buildTaskPrompt(t: {
  title: string; body: string; cardId: number; attemptId: number; dispatchId: string;
  /** Engine-authored extra paragraph (T8 send-back resume comments). */
  extra?: string | null;
}): string {
  const body = t.body.trim();
  const extra = t.extra?.trim();
  return sanitizePromptText(
    [
      `Task: ${t.title}`,
      body || null,
      `You are working on codegent card ${t.cardId}, attempt ${t.attemptId}, dispatch ${t.dispatchId}. ` +
        `Use the codegent MCP tools: call task_get to re-read this task, and call task_progress with a one-line note after each meaningful step. ` +
        `When you are finished, commit your work in this worktree, then call task_complete with a short summary — completion is rejected while the worktree has uncommitted changes. ` +
        `Report completion exactly once, even if the task failed: call task_complete describing what went wrong instead of leaving the task open.`,
      extra || null,
    ]
      .filter((x): x is string => x !== null)
      .join("\n\n"),
  );
}

/**
 * Pure normalizer: raw CC hook payload → content-free signals, mapped exactly
 * per the verified truth table. Anything unknown or malformed → [] (fail-open;
 * I2: ambiguity degrades to attention elsewhere, never to false progress here).
 */
export function normalizeClaudeHook(event: unknown): AdapterSignal[] {
  if (typeof event !== "object" || event === null) return [];
  const e = event as Record<string, unknown>;
  switch (e.hook_event_name) {
    case "SessionStart": // source startup|resume both — capture the CLI's own session id
      return typeof e.session_id === "string" && e.session_id
        ? [{ s: "session-started", adapterSessionId: e.session_id }]
        : [];
    case "PermissionRequest":
      // AskUserQuestion fires this too, ~18ms after its PreToolUse (s3 capture) —
      // reclassify rather than suppress, so the question flag survives even if
      // the PreToolUse delivery drops on the fail-open transport.
      return [{ s: "flag", kind: e.tool_name === "AskUserQuestion" ? "question" : "permission" }];
    case "PreToolUse":
      return e.tool_name === "AskUserQuestion" ? [{ s: "flag", kind: "question" }] : [];
    case "PostToolUse": // the hook-visible answer (contract doc claim 3) — native flag-clear
      return e.tool_name === "AskUserQuestion" ? [{ s: "flag-clear" }] : [];
    case "Stop": // never "done" by itself — the engine evaluates pending task_complete
      return [{ s: "complete-eval" }];
    case "StopFailure":
      return [{ s: "stop-failure" }];
    default:
      return [];
  }
}

/** 0600 write that keeps the mode pinned on rewrite (receiver.ts discipline). */
function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Resolve when output has been quiet for `quietMs` after at least one chunk,
 * or at `capMs` regardless (a silent/dead CLI must not stall the dispatch —
 * injecting into it is harmless). */
async function awaitPasteReady(sess: AdapterPtySession, t: InjectTiming): Promise<void> {
  const start = Date.now();
  let last = 0;
  const off = sess.onData(() => {
    last = Date.now();
  });
  try {
    const poll = Math.max(5, Math.min(25, t.quietMs));
    for (;;) {
      const now = Date.now();
      if (last > 0 && now - last >= t.quietMs) return;
      if (now - start >= t.capMs) return;
      await Bun.sleep(poll);
    }
  } finally {
    off();
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly agent = "claude" as const;
  private timing: InjectTiming;

  constructor(private deps: ClaudeAdapterDeps) {
    this.timing = { ...DEFAULT_INJECT_TIMING, ...deps.timing };
  }

  async spawn(ctx: SpawnCtx): Promise<SpawnResult> {
    const { dataDir, hookPort, hookToken, ptys } = this.deps;
    // Per-dispatch config dir under the 0700 signal-plane tree (Orca layout).
    const dir = join(dataDir, "agents", ctx.dispatch.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // T6's fail-open forwarder — idempotent rewrite, returns the canonical path.
    const hookScript = writeHookScript(dataDir);
    // Session identity baked into the command STRING (not PTY env): hook
    // commands run through the CLI's own shell, so the assignment survives any
    // env filtering claude applies to its children. The id is the dispatch id —
    // known before the PTY exists, unique per agent pane.
    const sid = ctx.dispatch.id;
    const command = `CODEGENT_SESSION_ID=${shq(sid)} ${shq(hookScript)} claude`;
    const hook = { hooks: [{ type: "command", command }] };
    const settingsPath = join(dir, "settings.json");
    writePrivate(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            // Recorded working shape (spike settings.json): entries WITHOUT a
            // matcher key fire for everything; the two tool events are scoped
            // to AskUserQuestion by tool-name matcher (contract doc claim 3).
            SessionStart: [hook],
            PreToolUse: [{ matcher: "AskUserQuestion", ...hook }],
            PostToolUse: [{ matcher: "AskUserQuestion", ...hook }],
            PermissionRequest: [hook],
            Stop: [hook],
            StopFailure: [hook],
          } satisfies Record<(typeof HOOK_EVENTS)[number], unknown>,
        },
        null,
        2,
      ),
    );

    // MCP sidecar (mcp-entry.ts header contract): stdio server `bun <entry>`
    // with the signal-plane endpoint + dispatch envelope in env.
    const mcpPath = join(dir, "mcp.json");
    writePrivate(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            codegent: {
              command: "bun",
              args: [join(import.meta.dir, "mcp-entry.ts")],
              env: {
                CODEGENT_HOOK_PORT: String(hookPort),
                CODEGENT_HOOK_TOKEN: hookToken,
                CODEGENT_CARD_ID: String(ctx.card.id),
                CODEGENT_DISPATCH_ID: ctx.dispatch.id,
              },
            },
          },
        },
        null,
        2,
      ),
    );

    // `--settings <file> --setting-sources project`: the contract doc's
    // validated no-repo-dirty injection path (§4) — user-global settings never
    // reach a managed session. Mode flags per spec §6 + the recorded 2.1.215
    // surfaces: host = YOLO; auto = CC's native sandbox mode (the `auto`
    // choice of the recorded --permission-mode enum); ask = stock prompting.
    // --resume re-passes the SAME mode flags (spec §4.3: a resumed session
    // must never silently change permission mode).
    const cmd = [
      "claude",
      "--settings", settingsPath,
      "--setting-sources", "project",
      "--mcp-config", mcpPath,
      ...(ctx.mode === "host"
        ? ["--dangerously-skip-permissions"]
        : ctx.mode === "auto"
          ? ["--permission-mode", "auto"]
          : []),
      ...(ctx.resumeSessionId ? ["--resume", ctx.resumeSessionId] : []),
    ];

    // scrubAgentEnv drops CLAUDE* (leaked nested-CC markers silently disable
    // transcript persistence and break --resume) and pins TERM; CODEGENT_*
    // rides on top for the hook script's env fallback path.
    const meta = ptys.open({
      projectId: ctx.project.id,
      cwd: ctx.worktreePath,
      title: ctx.card.title,
      worktreeId: ctx.attempt.worktreeId,
      kind: "agent",
      cmd,
      env: {
        ...scrubAgentEnv(process.env),
        CODEGENT_HOOK_PORT: String(hookPort),
        CODEGENT_HOOK_TOKEN: hookToken,
        CODEGENT_SESSION_ID: sid,
      },
      attemptId: ctx.attempt.id,
    });

    // Prompt injection, best-effort: a session that died at spawn is the
    // engine's problem (it sees the live:false session event), never spawn()'s.
    const sess = ptys.get(meta.id);
    if (sess) {
      try {
        await awaitPasteReady(sess, this.timing);
        // \x15 (Ctrl+U) first: CC restores an interrupted prompt into the
        // composer, and injected text would concatenate onto it (contract doc
        // claim d). Then the prompt as ONE write — CC treats large writes as
        // paste, keeping body newlines soft — and the \r submit SEPARATELY
        // after a settle: an embedded \r would be swallowed by paste handling.
        sess.write("\x15" + buildTaskPrompt({
          title: ctx.card.title,
          body: ctx.card.body,
          cardId: ctx.card.id,
          attemptId: ctx.attempt.id,
          dispatchId: ctx.dispatch.id,
          extra: ctx.extraPrompt,
        }));
        await Bun.sleep(this.timing.enterDelayMs);
        sess.write("\r");
      } catch {
        // PTY died mid-injection — nothing to salvage here.
      }
    }

    return { sessionMeta: meta, settingsDir: dir };
  }

  onHook(_sessionId: string, event: unknown): AdapterSignal[] {
    return normalizeClaudeHook(event);
  }
}
