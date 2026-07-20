import { describe, expect, test } from "bun:test";
import { OscScanner, classifyOsc } from "../../src/detect/osc";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function scan(value: string): OscScanner {
  const scanner = new OscScanner();
  scanner.feed(encode(value));
  return scanner;
}

describe("OscScanner", () => {
  test("retains an OSC 0 title terminated by BEL", () => {
    const scanner = scan("before\x1b]0;⠋ claude\x07after");

    expect(scanner.title).toBe("⠋ claude");
    expect(classifyOsc(scanner.title, scanner.progress)).toBe("working");
  });

  test("retains an OSC 2 title independently from OSC 9 progress", () => {
    const scanner = scan("\x1b]2;✳ idle title\x07\x1b]9;4;3;\x07");

    expect(scanner.title).toBe("✳ idle title");
    expect(scanner.progress).toBe("4;3;");
    expect(classifyOsc(scanner.title, scanner.progress)).toBe("idle");
  });

  test("recognizes OSC 9 done progress as idle where an agent emits it", () => {
    const scanner = scan("\x1b]9;4;0;\x07");

    expect(scanner.progress).toBe("4;0;");
    expect(classifyOsc(scanner.title, scanner.progress)).toBe("idle");
  });

  test("reassembles an OSC and a split UTF-8 glyph across feed calls", () => {
    const bytes = encode("\x1b]0;⠋ split title\x07");
    const scanner = new OscScanner();

    scanner.feed(bytes.slice(0, 5));
    expect(scanner.title).toBeNull();

    scanner.feed(bytes.slice(5));
    expect(scanner.title).toBe("⠋ split title");
  });

  test("accepts an ST terminator split across feed calls", () => {
    const scanner = new OscScanner();

    scanner.feed(encode("\x1b]2;◇ gemini\x1b"));
    expect(scanner.title).toBeNull();

    scanner.feed(encode("\\"));
    expect(scanner.title).toBe("◇ gemini");
  });

  test("caps retained values at 256 Unicode characters", () => {
    const scanner = scan(`\x1b]0;${"🙂".repeat(300)}\x07`);

    expect(scanner.title).toBe("🙂".repeat(256));
    expect(Array.from(scanner.title ?? "")).toHaveLength(256);
  });

  test("sanitizes C0, DEL, and C1 controls from retained values", () => {
    const scanner = scan("\x1b]0;safe\x00bad\x01\r\n\t\x7f\u0085end\x07");

    expect(scanner.title).toBe("safebadend");
  });

  test("clearOnAgentChange resets title and progress evidence", () => {
    const scanner = scan("\x1b]0;⠋ claude\x07\x1b]9;4;0;\x07");

    scanner.clearOnAgentChange();

    expect(scanner.title).toBeNull();
    expect(scanner.progress).toBeNull();
  });

  test("caps an in-flight OSC pending buffer at exactly 4 KiB", () => {
    const scanner = new OscScanner();
    const pending = scanner as unknown as { payload: number[] };

    scanner.feed(encode(`\x1b]0;${"x".repeat(4_094)}`));
    expect(pending.payload).toHaveLength(4_096);

    scanner.feed(encode("overflow"));
    expect(pending.payload).toHaveLength(4_096);
  });

  test("does not grow the OSC pending buffer for 1 MiB of non-OSC input", () => {
    const scanner = new OscScanner();
    const pending = scanner as unknown as { payload: number[] };

    scanner.feed(new Uint8Array(1024 * 1024).fill(0x78));

    expect(pending.payload).toHaveLength(0);
    expect(scanner.title).toBeNull();
    expect(scanner.progress).toBeNull();
  });

  test("recovers after discarding an overflowing OSC sequence", () => {
    const scanner = scan("\x1b]0;stable\x07");

    scanner.feed(encode(`\x1b]0;${"x".repeat(4_095)}\x07`));
    expect(scanner.title).toBe("stable");

    scanner.feed(encode("\x1b]2;recovered\x07"));
    expect(scanner.title).toBe("recovered");
  });

  test("clearOnAgentChange discards an in-flight partial OSC", () => {
    const scanner = new OscScanner();

    scanner.feed(encode("\x1b]2;previous agent"));
    scanner.clearOnAgentChange();
    scanner.feed(encode(" leaked title\x07"));

    expect(scanner.title).toBeNull();
    scanner.feed(encode("\x1b]2;current agent\x07"));
    expect(scanner.title).toBe("current agent");
  });
});

describe("classifyOsc", () => {
  test("classifies the live-verified Codex Action Required title as blocked", () => {
    expect(classifyOsc("[ ! ] Action Required | ~/proj", null)).toBe("blocked");
  });

  test.each([
    ["✋ gemini", "blocked"],
    ["✦ gemini", "working"],
    ["⏲ gemini", "working"],
    ["◇ gemini", "idle"],
  ] as const)("classifies the Gemini title %s as %s", (title, expected) => {
    expect(classifyOsc(title, null)).toBe(expected);
  });

  test.each([
    ["✳ permission pending", "idle"],
    ["✳ Action Required", "idle"],
    ["⠋ permission pending", "working"],
    ["⠋ Action Required", "working"],
  ] as const)("never derives blocked from the Claude-style title %s", (title, expected) => {
    expect(classifyOsc(title, null)).toBe(expected);
  });

  test.each([
    ["codex: ready", "idle"],
    ["aider is DONE", "idle"],
    ["gemini thinking", "working"],
    ["opencode running", "working"],
  ] as const)("uses path-safe state keywords in %s", (title, expected) => {
    expect(classifyOsc(title, null)).toBe(expected);
  });

  test("does not classify a path segment named ready as idle", () => {
    expect(classifyOsc("~/codex/ready", null)).toBeNull();
  });

  test("returns null for unknown titles and progress", () => {
    expect(classifyOsc("ordinary workspace title", null)).toBeNull();
    expect(classifyOsc(null, "4;3;")).toBeNull();
    expect(classifyOsc(null, null)).toBeNull();
  });
});
