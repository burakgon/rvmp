import { Ring, RING_CAP } from "./ring";

type DataCb = (b: Uint8Array) => void;

export interface PtySessionOpts {
  id: string;
  cwd: string;
  shell?: string;
  /** Full argv. Default stays the interactive shell `[$SHELL|/bin/sh, "-i"]`; adapters pass the agent CLI here. */
  cmd?: string[];
  /** Merged over the scrubbed base env. A key set to `undefined` unsets it. */
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  ringPath: string;
}

const TERM_NAME = "xterm-256color";
const FLUSH_INTERVAL_MS = 3000;
/** Rung spacing of the §6.1 terminate ladder: SIGHUP → 2s → SIGTERM → 2s → SIGKILL. */
const LADDER_STEP_MS = 2000;

/**
 * Base env for every PTY spawn. Drops every `CLAUDE*` key — hard rule from the
 * hook-contract doc: a leaked `CLAUDE_CODE_CHILD_SESSION` silently disables
 * transcript persistence and breaks `--resume`. `ANTHROPIC*` is deliberately
 * KEPT — legitimate user auth/gateway config (see task-7 review). Sets `TERM`
 * because Bun's `terminal.name` does NOT export it to the child (bun-pty-spike
 * gotcha #2).
 */
export function scrubAgentEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !/^CLAUDE/.test(k)) out[k] = v;
  }
  out.TERM = TERM_NAME;
  return out;
}

/**
 * One live PTY-backed process (interactive shell by default, agent CLI via
 * `cmd`). Output is delivered via the `data` callback of the `terminal` spawn
 * option (Bun 1.3.14 has no async iterator on Terminal — see
 * docs/research/bun-pty-spike.md), fanned out to subscribers, and accumulated
 * in a 200KB scrollback ring persisted to `ringPath`.
 */
export class PtySession {
  readonly id: string;
  /** Resolves with the process exit code, after the final ring flush. */
  readonly exited: Promise<number>;
  private proc: Bun.Subprocess;
  private term: Bun.Terminal;
  private ring: Ring;
  private cbs = new Set<DataCb>();
  private flushTimer: ReturnType<typeof setInterval>;
  private terminating?: Promise<number>;

  constructor(opts: PtySessionOpts) {
    this.id = opts.id;
    this.ring = new Ring(RING_CAP);
    const env = scrubAgentEnv(process.env);
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    this.proc = Bun.spawn({
      cmd: opts.cmd ?? [opts.shell ?? process.env.SHELL ?? "/bin/sh", "-i"],
      cwd: opts.cwd,
      env,
      // Fresh terminal per spawn (reuse across spawns is not runtime-verified).
      terminal: {
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 32,
        name: TERM_NAME,
        data: (_term, chunk) => {
          const b = chunk.slice(); // copy: the callback buffer must not be retained
          this.ring.push(b);
          for (const cb of this.cbs) cb(b);
        },
      },
    });
    this.term = this.proc.terminal!;
    this.flushTimer = setInterval(() => {
      this.ring.flushTo(opts.ringPath).catch(() => {});
    }, FLUSH_INTERVAL_MS);
    this.exited = this.proc.exited.finally(() => {
      clearInterval(this.flushTimer);
      try {
        // Free the PTY fd once the process is gone. Any PTY output still in
        // flight at this instant is dropped — acceptable for v0.1 scrollback.
        if (!this.term.closed) this.term.close();
      } catch {}
      return this.ring.flushTo(opts.ringPath).catch(() => {});
    });
  }

  /** PID of the spawned child. With `terminal`, Bun spawns it as session +
   * process-group leader (bun-pty-spike kill semantics), so this doubles as
   * the pgid of everything it spawns — the key for post-exit reaping (T8). */
  get pid(): number {
    return this.proc.pid;
  }

  onData(cb: DataCb): () => void {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }

  write(data: Uint8Array | string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  kill(): void {
    // SIGHUP ("terminal went away"), not the default SIGTERM: interactive
    // shells ignore SIGTERM, which would leave `exited` unresolved forever.
    this.proc.kill("SIGHUP");
  }

  /**
   * §6.1 cancel ladder: SIGHUP → 2s → SIGTERM → 2s → SIGKILL, resolving with
   * the exit code once the process is gone (after the final ring flush — same
   * promise as `exited`). Bun's `proc.kill` signals the child PID only, NOT
   * its process group (probe-verified on Bun 1.3.14, recorded in the task-4
   * report); descendants are covered indirectly — the child is the PTY
   * session leader, so its death makes the kernel SIGHUP the foreground
   * group. HUP-immune grandchildren (e.g. leftover MCP servers) are a
   * post-exit reaping concern (§6.1), not this ladder's.
   * Idempotent: concurrent calls share one ladder. Safe after exit (no-op).
   */
  terminate(): Promise<number> {
    return (this.terminating ??= this.runLadder());
  }

  private async runLadder(): Promise<number> {
    // Race sentinel is null; `exited` always resolves with a number
    // (128+signal for signal deaths, e.g. 143 on SIGTERM).
    const step = (): Promise<number | null> =>
      Promise.race([this.exited, Bun.sleep(LADDER_STEP_MS).then(() => null)]);
    this.proc.kill("SIGHUP");
    if ((await step()) === null) {
      this.proc.kill("SIGTERM");
      if ((await step()) === null) this.proc.kill("SIGKILL");
    }
    return this.exited;
  }

  snapshot(): Uint8Array {
    return this.ring.snapshot();
  }
}
