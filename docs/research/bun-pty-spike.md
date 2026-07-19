# Spike: Bun native PTY + single-binary gate (Task 2)

**Verdict: GATE PASSED.** Bun's native PTY delivers echo roundtrip + resize on macOS,
both under `bun test` and inside a `bun build --compile` binary. No sidecar needed.

- **Bun:** 1.3.14 · macOS (darwin arm64) · shell `/bin/zsh -i`
- **Proof:** `apps/daemon/test/spike-pty.test.ts` (permanent, 3/3 stable runs) and a
  compiled-binary rerun of the same logic (exit 0; scripts were under gitignored `docs/research/tmp/`).

## True API shape (differs from the plan's illustration)

```ts
const proc = Bun.spawn({
  cmd: ["/bin/zsh", "-i"],
  env: { ...process.env, TERM: "xterm-256color" }, // see gotcha #2
  terminal: {                       // TerminalOptions | Terminal — POSIX only
    cols: 80, rows: 24,             // defaults: 80×24
    name: "xterm-256color",         // termcap name; does NOT set child's TERM env
    data: (term, chunk) => {},      // Uint8Array output — the ONLY way to read
    exit: (term, code, signal) => {},  // PTY stream closed (0=EOF, 1=error) — NOT process exit
    drain: (term) => {},            // backpressure: ready for more writes
  },
});
proc.terminal;                      // Terminal | undefined (same class as new Bun.Terminal(opts))
```

`Terminal` members (runtime-verified): `write(data): number` (bytes written),
`resize(cols, rows)`, `setRawMode(bool)`, `close()`, `closed`, `ref()`/`unref()`,
`[Symbol.asyncDispose]`, termios accessors `inputFlags/outputFlags/localFlags/controlFlags`
(get/set). A `Terminal` instance can be reused across multiple spawns.

## Deviations from the illustrated test

1. **No async iteration.** `Terminal` has no `Symbol.asyncIterator`; `for await (const c of proc.terminal)`
   throws. Output arrives only via the `data` callback. (Test fixed accordingly.)
2. **`name` does not become `$TERM`.** With TERM stripped from env, the child saw an empty
   `$TERM`. PtySession must set `env.TERM` itself to match `name`.
3. **stdio is nulled.** With a terminal attached, `proc.stdin/stdout/stderr` are all `null` —
   don't mix pipe-based consumption with PTY mode.
4. Process exit is still `proc.exited` / `onExit`; the terminal `exit` callback is only the
   PTY read-stream lifecycle.

## Measurements

| Metric | Value |
|---|---|
| Warm echo roundtrip (zsh builtin, callback-timestamped) | **0.1–0.2 ms** |
| resize(120,40) → `stty size` prints `40 120` | 2.8–3.1 ms (kernel winsize confirmed) |
| Cold roundtrip incl. `zsh -i` startup | ~450–630 ms |
| `bun build --compile` | works; PTY numbers identical in-binary; binary ≈ 61 MB |

## Notes for Task 6 (PtySession)

- Copy each `data` chunk if retained (`chunk.slice()`); don't assume buffer lifetime.
- Honor backpressure: `write()` returns bytes written; use `drain` before resuming large writes.
- Resize is plain `term.resize(cols, rows)` + kernel SIGWINCH — no extra plumbing.
- Always `term.close()` after `proc.exited` (or use `await using`) to free the PTY fd.
