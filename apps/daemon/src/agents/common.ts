import { chmodSync, renameSync, writeFileSync } from "node:fs";
import type { AdapterPtySession, AdapterPtys } from "./types";

/**
 * Helpers shared by the premium adapters (Claude Code + Codex). Everything
 * here is agent-neutral: prompt composition/sanitization, atomic private file
 * writes, and the Orca-proven paste/submit injection sequence. Agent-specific
 * shapes (settings/hooks files, argv, mirrors) stay in the adapters.
 */

/** Injection timing. `capMs`/`quietMs` gate the paste on output-quiet (§6.1
 * layer 4: quiescence is a readiness gate only); `enterDelayMs` is the
 * paste→Enter gap — Orca-proven: agent TUIs treat large writes as paste and
 * swallow an embedded `\r`, so the submit must travel alone (orca-agent-state §6). */
export interface InjectTiming {
  capMs: number;
  quietMs: number;
  enterDelayMs: number;
}
export const DEFAULT_INJECT_TIMING: InjectTiming = { capMs: 3000, quietMs: 250, enterDelayMs: 500 };

/** POSIX single-quote, safe for paths/ids embedded in a hook command string. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Normalize newlines, strip every other C0 control + DEL (incl. ESC) — the
 * composed prompt must never carry a stray `\r` (premature submit) or escape
 * sequences (terminal control breakout inside the composer). */
export const sanitizePromptText = (s: string): string =>
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

/** Atomic tmp+rename write. `chmod` after write: writeFileSync's mode only
 * applies when the tmp file is created, and rewrites must keep the mode
 * pinned. POSIX rename: readers see old or new content, never partial —
 * config files an agent CLI may read while we refresh them go through this. */
export function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** 0600 atomic write for the managed per-dispatch config files. */
export function writePrivate(path: string, content: string): void {
  writeAtomic(path, content, 0o600);
}

/** Resolve when output has been quiet for `quietMs` after at least one chunk,
 * or at `capMs` regardless (a silent/dead CLI must not stall the dispatch —
 * injecting into it is harmless). */
export async function awaitPasteReady(sess: AdapterPtySession, t: InjectTiming): Promise<void> {
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

/**
 * Best-effort task-prompt injection into a freshly spawned agent PTY: a
 * session that died at spawn is the engine's problem (it sees the live:false
 * session event), never spawn()'s. Sequence (contract doc claim d + Orca §6):
 * `\x15` (Ctrl+U) first — CC restores an interrupted prompt into the
 * composer, and injected text would concatenate onto it; then the prompt as
 * ONE write — TUIs treat large writes as paste, keeping body newlines soft —
 * and the `\r` submit SEPARATELY after a settle: an embedded `\r` would be
 * swallowed by paste handling.
 */
export async function injectTaskPrompt(
  ptys: AdapterPtys, sessionId: string, text: string, timing: InjectTiming,
): Promise<void> {
  const sess = ptys.get(sessionId);
  if (!sess) return;
  try {
    await awaitPasteReady(sess, timing);
    sess.write("\x15" + text);
    await Bun.sleep(timing.enterDelayMs);
    sess.write("\r");
  } catch {
    // PTY died mid-injection — nothing to salvage here.
  }
}
