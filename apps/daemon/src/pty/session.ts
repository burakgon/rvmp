import { Ring, RING_CAP } from "./ring";

type DataCb = (b: Uint8Array) => void;

export interface PtySessionOpts {
  id: string;
  cwd: string;
  shell?: string;
  cols?: number;
  rows?: number;
  ringPath: string;
}

const TERM_NAME = "xterm-256color";
const FLUSH_INTERVAL_MS = 3000;

/**
 * One live PTY-backed shell. Output is delivered via the `data` callback of
 * the `terminal` spawn option (Bun 1.3.14 has no async iterator on Terminal —
 * see docs/research/bun-pty-spike.md), fanned out to subscribers, and
 * accumulated in a 200KB scrollback ring persisted to `ringPath`.
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

  constructor(opts: PtySessionOpts) {
    this.id = opts.id;
    this.ring = new Ring(RING_CAP);
    this.proc = Bun.spawn({
      cmd: [opts.shell ?? process.env.SHELL ?? "/bin/zsh", "-i"],
      cwd: opts.cwd,
      // `terminal.name` does NOT set the child's $TERM — export it ourselves.
      env: { ...process.env, TERM: TERM_NAME },
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

  snapshot(): Uint8Array {
    return this.ring.snapshot();
  }
}
