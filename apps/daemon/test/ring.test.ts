import { test, expect } from "bun:test";
import { Ring } from "../src/pty/ring";

test("ring keeps only last cap bytes", () => {
  const r = new Ring(10);
  r.push(new TextEncoder().encode("0123456789ABCDEF")); // 16 bytes into cap 10
  expect(new TextDecoder().decode(r.snapshot())).toBe("6789ABCDEF");
  r.push(new TextEncoder().encode("xy"));
  expect(new TextDecoder().decode(r.snapshot())).toBe("89ABCDEFxy");
});

test("ring flush/load roundtrip", async () => {
  const r = new Ring(1024);
  r.push(new TextEncoder().encode("persist me"));
  const p = `/tmp/codegent-ring-${crypto.randomUUID()}.bin`;
  await r.flushTo(p);
  const r2 = await Ring.load(p, 1024);
  expect(new TextDecoder().decode(r2.snapshot())).toBe("persist me");
});
