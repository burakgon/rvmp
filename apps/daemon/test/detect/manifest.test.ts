import { describe, expect, test } from "bun:test";
import { evaluate, loadManifest } from "../../src/detect/manifest";
import type { ScreenGrid } from "../../src/detect/types";

const grid = (overrides: Partial<ScreenGrid> = {}): ScreenGrid => ({
  rows: [],
  oscTitle: null,
  oscProgress: null,
  ...overrides,
});

function oneRule(fields: string) {
  return loadManifest(`
[[rules]]
id = "test-rule"
state = "blocked"
priority = 10
region = "whole_recent"
${fields}
`);
}

describe("loadManifest", () => {
  test("parses a small TOML manifest", () => {
    const manifest = loadManifest(`
[[rules]]
id = "ready"
state = "idle"
priority = 25
region = "bottom_lines(2)"
contains = ["Ready"]
`);

    expect(manifest.rules).toHaveLength(1);
    expect(manifest.rules[0]).toMatchObject({
      id: "ready",
      state: "idle",
      priority: 25,
      region: "bottom_lines(2)",
      contains: ["Ready"],
      skip_state_update: false,
    });
  });

  test("rejects malformed TOML with a clear load error", () => {
    expect(() => loadManifest("[[rules]\nid =")).toThrow(/invalid manifest TOML/i);
  });

  test("rejects a bad regex while loading, not while evaluating", () => {
    expect(() => oneRule('regex = ["("]')).toThrow(/rule test-rule.*invalid regex/i);
  });

  test("rejects unknown rule keys instead of silently dropping them", () => {
    expect(() => oneRule('contains = ["ready"]\nvisible_blocker = true')).toThrow(
      /invalid manifest.*rule test-rule.*unknown key.*visible_blocker/i,
    );
  });

  test("rejects more than 128 rules", () => {
    const rules = Array.from(
      { length: 129 },
      (_, index) => `
[[rules]]
id = "rule-${index}"
state = "idle"
priority = ${index}
region = "whole_recent"
contains = ["ready"]`,
    ).join("\n");

    expect(() => loadManifest(rules)).toThrow(/129 rules.*maximum is 128/i);
  });

  test("rejects more than 512 gates", () => {
    const gates = Array.from({ length: 512 }, () => '{ contains = ["ready"] }').join(",");

    expect(() => oneRule(`any = [${gates}]`)).toThrow(/gate count.*512/i);
  });

  test("rejects more than 1024 matchers", () => {
    const matchers = Array.from({ length: 1_025 }, (_, index) => `"matcher-${index}"`).join(
      ",",
    );

    expect(() => oneRule(`contains = [${matchers}]`)).toThrow(/matcher count.*1024/i);
  });

  test("rejects a matcher longer than 512 characters", () => {
    expect(() => oneRule(`contains = ["${"x".repeat(513)}"]`)).toThrow(
      /matcher.*length.*512/i,
    );
  });

  test("rejects gate nesting deeper than eight", () => {
    const nestedAll = (depth: number): string =>
      depth === 0 ? '{ contains = ["needle"] }' : `{ all = [${nestedAll(depth - 1)}] }`;

    expect(() => oneRule(`all = [${nestedAll(8)}]`)).toThrow(/gate depth.*8/i);
  });
});

describe("evaluate", () => {
  test("chooses the highest-priority matching rule", () => {
    const manifest = loadManifest(`
[[rules]]
id = "higher"
state = "blocked"
priority = 20
region = "whole_recent"
contains = ["same evidence"]

[[rules]]
id = "lower"
state = "working"
priority = 10
region = "whole_recent"
contains = ["same evidence"]
`);

    expect(evaluate(manifest, grid({ rows: ["same evidence"] }))).toEqual({
      state: "blocked",
      ruleId: "higher",
      fallback: false,
    });
  });

  test("uses file order to break equal-priority ties", () => {
    const manifest = loadManifest(`
[[rules]]
id = "first"
state = "working"
priority = 10
region = "whole_recent"
contains = ["same evidence"]

[[rules]]
id = "second"
state = "blocked"
priority = 10
region = "whole_recent"
contains = ["same evidence"]
`);

    expect(evaluate(manifest, grid({ rows: ["same evidence"] }))).toEqual({
      state: "working",
      ruleId: "first",
      fallback: false,
    });
  });

  test("bottom_non_empty_lines returns only the requested non-empty rows", () => {
    const manifest = loadManifest(String.raw`
[[rules]]
id = "bottom-non-empty"
state = "working"
priority = 10
region = "bottom_non_empty_lines(2)"
regex = ['^first\nsecond$']
`);

    expect(evaluate(manifest, grid({ rows: ["first", "", "second", "", ""] })).ruleId).toBe(
      "bottom-non-empty",
    );
  });

  test("top_non_empty_lines returns only the first requested non-empty rows", () => {
    const manifest = loadManifest(String.raw`
[[rules]]
id = "top-non-empty"
state = "working"
priority = 10
region = "top_non_empty_lines(2)"
regex = ['^first\nsecond$']
`);

    expect(
      evaluate(manifest, grid({ rows: ["first", "", "second", "", "third"] })).ruleId,
    ).toBe("top-non-empty");
  });

  test.each([
    ["rounded-corner", ["╭──────╮", "  ❯ hi  ", "╰──────╯"]],
    ["plain-rule", ["────────", "  ❯ hi  ", "────────"]],
  ] as const)("extracts prompt_box_body from a %s box", (_style, rows) => {
    const manifest = loadManifest(String.raw`
[[rules]]
id = "prompt"
state = "idle"
priority = 10
region = "prompt_box_body"
regex = ['^\s*❯ hi\s*$']
`);

    expect(evaluate(manifest, grid({ rows: [...rows] })).ruleId).toBe("prompt");
  });

  test.each([
    ["whole_recent", ["TOP_A", "BOTTOM_LAST"], []],
    ["bottom_lines(2)", ["BOTTOM_LAST"], ["AFTER_ONE"]],
    ["bottom_non_empty_lines(2)", ["AFTER_ONE", "BOTTOM_LAST"], ["BOX_TWO"]],
    ["top_non_empty_lines(2)", ["TOP_A", "TOP_B"], ["BOX_ONE"]],
    ["prompt_box_body", ["BOX_ONE", "BOX_TWO"], ["STALE_BOX", "AFTER_ONE"]],
    ["above_prompt_box", ["TOP_A", "ABOVE_ONLY", "STALE_BOX"], ["BOX_ONE"]],
    ["after_last_horizontal_rule", ["AFTER_ONE", "BOTTOM_LAST"], ["BOX_TWO"]],
    ["osc_title", ["TITLE_ONLY"], ["TOP_A"]],
    ["osc_progress", ["PROGRESS_ONLY"], ["BOTTOM_LAST"]],
  ] as const)("extracts the %s region", (region, required, excluded) => {
    const manifest = loadManifest(`
[[rules]]
id = "${region}"
state = "working"
priority = 10
region = "${region}"
contains = [${required.map((value) => `"${value}"`).join(", ")}]
not = [${excluded.map((value) => `{ contains = ["${value}"] }`).join(", ")}]
`);
    const fixture = grid({
      rows: [
        "TOP_A",
        "",
        "TOP_B ABOVE_ONLY",
        "────────",
        "STALE_BOX",
        "╭────────╮",
        "BOX_ONE",
        "BOX_TWO",
        "╰────────╯",
        "AFTER_ONE",
        "",
        "BOTTOM_LAST",
      ],
      oscTitle: "TITLE_ONLY",
      oscProgress: "PROGRESS_ONLY",
    });

    expect(evaluate(manifest, fixture).ruleId).toBe(region);
  });

  test("uses retained OSC metadata instead of similarly named screen rows", () => {
    const manifest = loadManifest(`
[[rules]]
id = "test-rule"
state = "blocked"
priority = 10
region = "osc_title"
contains = ["retained title"]
`);

    expect(
      evaluate(manifest, grid({ rows: ["retained title"], oscTitle: "different title" })),
    ).toEqual({
      state: "idle",
      ruleId: "default_known_agent_idle_fallback",
      fallback: true,
    });
    expect(
      evaluate(manifest, grid({ rows: ["different title"], oscTitle: "retained title" })),
    ).toEqual({
      state: "blocked",
      ruleId: "test-rule",
      fallback: false,
    });
  });

  test("matches lowercased contains, regex, and per-line line_regex", () => {
    const manifest = loadManifest(String.raw`
[[rules]]
id = "all-matchers"
state = "working"
priority = 10
region = "whole_recent"
contains = ["ACTION REQUIRED"]
regex = ['Working\s+now']
line_regex = ['^\s*> approve$']
`);

    expect(
      evaluate(manifest, grid({ rows: ["action required: Working now", "  > approve"] })),
    ).toEqual({ state: "working", ruleId: "all-matchers", fallback: false });
    expect(
      evaluate(manifest, grid({ rows: ["action required: Working now", "prefix > approve"] })),
    ).toEqual({
      state: "idle",
      ruleId: "default_known_agent_idle_fallback",
      fallback: true,
    });
  });

  test("precompiles Herdr-style inline flags and Unicode code-point escapes", () => {
    const manifest = loadManifest(String.raw`
[[rules]]
id = "herdr-regex"
state = "idle"
priority = 10
region = "osc_title"
regex = ['(?i)^\x{2733} ready$']
`);

    expect(evaluate(manifest, grid({ oscTitle: "✳ READY" }))).toEqual({
      state: "idle",
      ruleId: "herdr-regex",
      fallback: false,
    });
  });

  test("evaluates nested all, any, and not gates through depth eight", () => {
    const nestedAll = (depth: number): string =>
      depth === 0 ? '{ contains = ["deep"] }' : `{ all = [${nestedAll(depth - 1)}] }`;
    const manifest = loadManifest(`
[[rules]]
id = "nested"
state = "blocked"
priority = 10
region = "whole_recent"
contains = ["base"]
all = [${nestedAll(7)}]
any = [{ contains = ["missing"] }, { contains = ["choice"] }]
not = [{ contains = ["forbidden"], any = [{ contains = ["together"] }] }]
`);

    expect(evaluate(manifest, grid({ rows: ["base deep choice forbidden"] })).ruleId).toBe("nested");
    expect(evaluate(manifest, grid({ rows: ["base deep choice forbidden together"] }))).toEqual({
      state: "idle",
      ruleId: "default_known_agent_idle_fallback",
      fallback: true,
    });
  });

  test("falls back to idle on an unknown screen and never guesses blocked", () => {
    const result = evaluate(
      oneRule('contains = ["positive blocker evidence"]'),
      grid({ rows: ["an unfamiliar agent screen"] }),
    );

    expect(result).toEqual({
      state: "idle",
      ruleId: "default_known_agent_idle_fallback",
      fallback: true,
    });
    expect(result.state).not.toBe("blocked");
  });

  test("returns a freeze sentinel for skip_state_update viewer rules", () => {
    const manifest = loadManifest(`
[[rules]]
id = "transcript-viewer"
state = "unknown"
priority = 1000
region = "bottom_non_empty_lines(3)"
contains = ["showing detailed transcript"]
skip_state_update = true
`);

    expect(evaluate(manifest, grid({ rows: ["Showing Detailed Transcript"] }))).toEqual({
      state: "unknown",
      ruleId: "transcript-viewer",
      fallback: false,
      freeze: true,
    });
  });
});
