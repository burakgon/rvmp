import { test, expect } from "bun:test";

// Spike (Task 2, permanent): proves Bun's native PTY on this platform.
//
// True API shape in Bun 1.3.14 (differs from the plan's illustration):
//   - Output is delivered via the `data` callback in the `terminal` spawn
//     option — `Terminal` has NO Symbol.asyncIterator, so `for await` over
//     `proc.terminal` does not work.
//   - With a terminal attached, proc.stdin/stdout/stderr are all null.
//   - `term.write()` returns bytes written; `term.resize(cols, rows)`.
// Full findings: docs/research/bun-pty-spike.md

const SHELL = process.env.SHELL ?? "/bin/zsh";

/** Poll until `read()` contains `marker`; resolves with elapsed ms. */
async function waitFor(
  read: () => string,
  marker: string,
  timeoutMs: number,
): Promise<number> {
  const start = performance.now();
  for (;;) {
    if (read().includes(marker)) return performance.now() - start;
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(marker)}; ` +
          `last output: ${JSON.stringify(read().slice(-500))}`,
      );
    }
    await Bun.sleep(20);
  }
}

test("Bun.spawn terminal: echo roundtrip + resize", async () => {
  const chunks: Uint8Array[] = [];
  const output = () => Buffer.concat(chunks).toString();

  const proc = Bun.spawn({
    cmd: [SHELL, "-i"],
    env: { ...process.env, PS1: "SPIKE$ " },
    terminal: {
      cols: 80,
      rows: 24,
      data: (_term: unknown, data: Uint8Array) => {
        chunks.push(data.slice()); // copy: don't assume the buffer outlives the callback
      },
    },
  });

  const term = proc.terminal!;
  expect(term).toBeDefined();
  // With a terminal attached, stdio is routed through the PTY — streams are null.
  expect(proc.stdout).toBeNull();

  try {
    // 1. Echo roundtrip. The marker is split in the input ("PTY_OK_%s" + "42"),
    // so PTY input echo alone can never contain the contiguous "PTY_OK_42" —
    // only actual execution through the PTY produces it.
    const written = term.write("printf 'PTY_OK_%s\\n' 42\r");
    expect(written).toBeGreaterThan(0);
    const coldMs = await waitFor(output, "PTY_OK_42", 10_000);

    // 2. Resize, then prove the kernel saw the new winsize: `stty size`
    // prints "rows cols". Only chunks arriving after the resize count.
    term.resize(120, 40);
    const mark = chunks.length;
    term.write("stty size\r");
    const resizeMs = await waitFor(
      () => Buffer.concat(chunks.slice(mark)).toString(),
      "40 120",
      5_000,
    );

    console.log(
      `[spike-pty] cold roundtrip (incl. ${SHELL} -i startup): ${coldMs.toFixed(0)}ms; ` +
        `stty-after-resize roundtrip: ${resizeMs.toFixed(0)}ms`,
    );

    term.write("exit\r");
    await proc.exited;
  } finally {
    term.close();
  }
}, 15_000);
