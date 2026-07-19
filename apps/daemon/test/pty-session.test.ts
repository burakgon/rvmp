import { test, expect } from "bun:test";
import { PtySession } from "../src/pty/session";

/** Poll until `read()` contains `marker`, bounded by a deadline (Task-2 spike style). */
async function waitFor(
  read: () => string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const start = performance.now();
  while (!read().includes(marker)) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(marker)}; ` +
          `last output: ${JSON.stringify(read().slice(-500))}`,
      );
    }
    await Bun.sleep(20);
  }
}

test("pty session: data flows, ring accumulates, write works", async () => {
  const ringPath = `/tmp/codegent-s-${crypto.randomUUID()}.bin`;
  const s = new PtySession({ id: "s1", cwd: "/tmp", ringPath });
  const got: Uint8Array[] = [];
  const off = s.onData((b) => got.push(b));
  // Marker split in the input ("SESSION_%s" + "OK"): PTY input echo alone can
  // never contain the contiguous "SESSION_OK" — only real execution produces it.
  s.write("printf 'SESSION_%s\\n' OK\r");
  await waitFor(() => new TextDecoder().decode(s.snapshot()), "SESSION_OK", 10_000);
  s.write("exit\r");
  await s.exited;
  off();
  const all = new TextDecoder().decode(s.snapshot());
  expect(all).toContain("SESSION_OK");
  expect(got.length).toBeGreaterThan(0);
  // `exited` resolves only after the final ring flush — scrollback persisted.
  const persisted = new Uint8Array(await Bun.file(ringPath).arrayBuffer());
  expect(new TextDecoder().decode(persisted)).toContain("SESSION_OK");
}, 15000);

test("pty session: kill() terminates the shell and resolves exited", async () => {
  const ringPath = `/tmp/codegent-k-${crypto.randomUUID()}.bin`;
  const s = new PtySession({ id: "k1", cwd: "/tmp", ringPath });
  // Wait for first output (prompt) so we kill a fully started interactive shell —
  // interactive shells ignore SIGTERM, which is exactly what this test pins down.
  await waitFor(() => (s.snapshot().length > 0 ? "up" : ""), "up", 10_000);
  s.kill();
  const code = await s.exited;
  expect(typeof code).toBe("number");
}, 15000);
