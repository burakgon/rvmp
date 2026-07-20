import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../../src/detect/manifest";
import type { Manifest } from "../../src/detect/manifest";
import {
  BUNDLED_MANIFEST_NAMES,
  manifestFor,
} from "../../src/detect/manifests";
import type { ScreenGrid } from "../../src/detect/types";

const grid = (overrides: Partial<ScreenGrid> = {}): ScreenGrid => ({
  rows: [],
  oscTitle: null,
  oscProgress: null,
  ...overrides,
});

function withOverrideDir(run: (overrideDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "codegent-manifests-"));
  const overrideDir = join(root, "agent-detection");
  mkdirSync(overrideDir);
  try {
    run(overrideDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bundled(agent: string): Manifest {
  const root = mkdtempSync(join(tmpdir(), "codegent-manifests-bundled-"));
  const overrideDir = join(root, "agent-detection");
  mkdirSync(overrideDir);
  try {
    const manifest = manifestFor(agent, { overrideDir });
    if (manifest === null) throw new Error(`missing bundled manifest for ${agent}`);
    return manifest;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bundled agent detection manifests", () => {
  test.each([...BUNDLED_MANIFEST_NAMES])("%s.toml is bundled and schema-valid", (agent) => {
    const manifest = bundled(agent);
    expect(manifest.rules.length).toBeGreaterThan(0);
  });

  const fixtures: {
    agent: string;
    name: string;
    provenance: "captured" | "DERIVED-per-doc";
    source: string;
    fixture: ScreenGrid;
    expected: "idle" | "working" | "blocked" | "unknown";
    expectedRuleId?: string;
  }[] = [
    {
      agent: "claude",
      name: "bordered prompt at rest",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:204-205",
      fixture: grid({ rows: ["conversation", "────────", "  ❯ ", "────────"] }),
      expected: "idle",
    },
    // Claude OSC title copied verbatim from the live PTY capture recorded at
    // docs/research/cc-codex-hook-contract.md:91-104.
    {
      agent: "claude",
      name: "braille OSC title",
      provenance: "captured",
      source: "docs/research/cc-codex-hook-contract.md:91-104 live PTY capture",
      fixture: grid({ oscTitle: "⠐ Create spike4.txt file" }),
      expected: "working",
    },
    {
      agent: "claude",
      name: "numbered proceed confirmation",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:199-201",
      fixture: grid({
        rows: ["tool call", "────────", "Do you want to proceed?", "❯ 1. Yes", "  2. No"],
      }),
      expected: "blocked",
    },
    // Captured verbatim from a fresh Claude Code 2.1.215 tmux PTY on 2026-07-20.
    {
      agent: "claude",
      name: "live three-option permission dialog",
      provenance: "captured",
      source: "fresh Claude Code 2.1.215 tmux PTY capture, 2026-07-20",
      fixture: grid({
        rows: [
          `╰${"─".repeat(98)}╯`,
          "",
          " ⚠ Safe mode: all customizations are disabled (CLAUDE.md, skills, plugins, hooks, MCP, agents, and",
          "   more)",
          "   Restart without --safe-mode to re-enable",
          "",
          "❯ Use the Bash tool to run exactly: touch /tmp/codegent-claude-fix.xSxtNX/permission-proof.txt",
          "",
          "⏺ Bash(touch /tmp/codegent-claude-fix.xSxtNX/permission-proof.txt)",
          "",
          "─".repeat(100),
          " Bash command",
          "",
          "   touch /tmp/codegent-claude-fix.xSxtNX/permission-proof.txt",
          "   Create permission-proof.txt file",
          "",
          " Do you want to proceed?",
          " ❯ 1. Yes",
          "   2. Yes, and always allow access to codegent-claude-fix.xSxtNX/ from this project",
          "   3. No",
          "",
          " Esc to cancel · Tab to amend · ctrl+e to explain",
        ],
      }),
      expected: "blocked",
      expectedRuleId: "numbered_proceed_blocked",
    },
    {
      agent: "claude",
      name: "bordered composer followed by proceed confirmation",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:99-104,199-205",
      fixture: grid({
        rows: [
          "╭────────────╮",
          "  ❯ ",
          "╰────────────╯",
          "Do you want to proceed?",
          "❯ 1. Yes",
          "  2. No",
        ],
      }),
      expected: "blocked",
      expectedRuleId: "numbered_proceed_blocked",
    },
    {
      agent: "claude",
      name: "rounded-box proceed confirmation",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:99-104,199-205",
      fixture: grid({
        rows: [
          "╭────────────╮",
          "Do you want to proceed?",
          "❯ 1. Yes",
          "  2. No",
          "╰────────────╯",
        ],
      }),
      expected: "blocked",
      expectedRuleId: "numbered_proceed_blocked",
    },
    {
      agent: "claude",
      name: "transcript viewer ctrl+o hint",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:206-207",
      fixture: grid({ rows: ["Showing detailed transcript", "ctrl+o to toggle"] }),
      expected: "unknown",
      expectedRuleId: "transcript_viewer",
    },
    {
      agent: "claude",
      name: "transcript viewer ctrl+e hint",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:206-207",
      fixture: grid({ rows: ["Showing detailed transcript", "ctrl+e to explain"] }),
      expected: "unknown",
      expectedRuleId: "transcript_viewer",
    },
    {
      agent: "claude",
      name: "unknown screen",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:106-109",
      fixture: grid({ rows: ["unrecognized Claude screen"] }),
      expected: "idle",
    },

    // Codex titles copied verbatim from the live capture recorded at
    // docs/research/cc-codex-hook-contract.md:139-150.
    {
      agent: "codex",
      name: "plain non-spinner title",
      provenance: "captured",
      source: "docs/research/cc-codex-hook-contract.md:139-150 live PTY capture",
      fixture: grid({ oscTitle: "proj-codex" }),
      expected: "idle",
    },
    {
      agent: "codex",
      name: "braille OSC title",
      provenance: "captured",
      source: "docs/research/cc-codex-hook-contract.md:139-150 live PTY capture",
      fixture: grid({ oscTitle: "⠹ proj-codex" }),
      expected: "working",
    },
    {
      agent: "codex",
      name: "Action Required OSC title",
      provenance: "captured",
      source: "docs/research/cc-codex-hook-contract.md:139-150 live PTY capture",
      fixture: grid({ oscTitle: "[ ! ] Action Required | proj-codex" }),
      expected: "blocked",
    },
    {
      agent: "codex",
      name: "screen working fallback",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:222-225",
      fixture: grid({ rows: ["answer", "", "• Working (12s • esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "codex",
      name: "unknown screen",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:106-109",
      fixture: grid({ rows: ["unrecognized Codex screen"] }),
      expected: "idle",
    },

    {
      agent: "gemini",
      name: "diamond OSC title",
      provenance: "DERIVED-per-doc",
      source: "docs/research/orca-agent-state.md:30-40",
      fixture: grid({ oscTitle: "◇ Gemini" }),
      expected: "idle",
    },
    {
      agent: "gemini",
      name: "working OSC title",
      provenance: "DERIVED-per-doc",
      source: "docs/research/orca-agent-state.md:30-40",
      fixture: grid({ oscTitle: "✦ Gemini" }),
      expected: "working",
    },
    {
      agent: "gemini",
      name: "permission OSC title",
      provenance: "DERIVED-per-doc",
      source: "docs/research/orca-agent-state.md:30-40",
      fixture: grid({ oscTitle: "✋ Gemini" }),
      expected: "blocked",
    },
    {
      agent: "gemini",
      name: "bordered prompt at rest",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:99-104",
      fixture: grid({ rows: ["response", "────────", "> ", "────────"] }),
      expected: "idle",
    },
    {
      agent: "gemini",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:136-141",
      fixture: grid({ rows: ["✦ Thinking (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "gemini",
      name: "explicit yes/no confirmation",
      provenance: "DERIVED-per-doc",
      source: "docs/research/orca-agent-state.md:34,95",
      fixture: grid({ rows: ["Allow this tool?", "> Yes", "  No"] }),
      expected: "blocked",
    },
    {
      agent: "gemini",
      name: "unknown screen",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:106-109",
      fixture: grid({ rows: ["unrecognized Gemini screen"] }),
      expected: "idle",
    },

    {
      agent: "opencode",
      name: "bordered prompt at rest",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:99-104",
      fixture: grid({ rows: ["response", "────────", "❯ ", "────────"] }),
      expected: "idle",
    },
    {
      agent: "opencode",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:136-141",
      fixture: grid({ rows: ["⠋ Working (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "opencode",
      name: "explicit yes/no confirmation",
      provenance: "DERIVED-per-doc",
      source: "docs/research/orca-agent-state.md:91-95",
      fixture: grid({ rows: ["Approve this action?", "❯ Yes", "  No"] }),
      expected: "blocked",
    },
    {
      agent: "opencode",
      name: "unknown screen",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:106-109",
      fixture: grid({ rows: ["unrecognized OpenCode screen"] }),
      expected: "idle",
    },
    {
      agent: "aider",
      name: "bordered prompt at rest",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:99-104",
      fixture: grid({ rows: ["response", "────────", "aider> ", "────────"] }),
      expected: "idle",
    },
    {
      agent: "aider",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:136-141",
      fixture: grid({ rows: ["⠋ Editing app.ts (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "aider",
      name: "explicit yes/no confirmation",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:106-109,199-201",
      fixture: grid({ rows: ["Create this file?", "> Yes", "  No"] }),
      expected: "blocked",
    },
    {
      agent: "aider",
      name: "unknown screen",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:106-109",
      fixture: grid({ rows: ["unrecognized Aider screen"] }),
      expected: "idle",
    },

    {
      agent: "generic",
      name: "braille OSC title",
      provenance: "DERIVED-per-doc",
      source: "docs/research/orca-agent-state.md:30-40",
      fixture: grid({ oscTitle: "⠋ Running" }),
      expected: "working",
    },
    {
      agent: "generic",
      name: "spinner interrupt hint",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:136-141",
      fixture: grid({ rows: ["◦ Working (esc to interrupt)"] }),
      expected: "working",
    },
    {
      agent: "generic",
      name: "unknown screen",
      provenance: "DERIVED-per-doc",
      source: "docs/research/herdr-agent-state.md:106-109",
      fixture: grid({ rows: ["unrecognized agent screen"] }),
      expected: "idle",
    },
  ];

  test.each(fixtures)(
    "$agent: $name [$provenance; $source] -> $expected",
    ({ agent, fixture, expected, expectedRuleId }) => {
      const result = evaluate(bundled(agent), fixture);
      expect(result.state).toBe(expected);
      if (expectedRuleId !== undefined) expect(result.ruleId).toBe(expectedRuleId);
    },
  );

  test("Claude idle title containing permission text never becomes blocked", () => {
    const result = evaluate(
      bundled("claude"),
      grid({ oscTitle: "✳ Waiting for permission", rows: ["Permission required"] }),
    );

    expect(result).toMatchObject({ state: "idle", ruleId: "osc_title_idle" });
  });

  test("Codex Action Required title is blocked and braille title is working", () => {
    const manifest = bundled("codex");
    expect(evaluate(manifest, grid({ oscTitle: "[ . ] Action Required | repo" }))).toMatchObject({
      state: "blocked",
      ruleId: "osc_title_action_required",
    });
    expect(evaluate(manifest, grid({ oscTitle: "⠹ repo" }))).toMatchObject({
      state: "working",
      ruleId: "osc_title_working",
    });
  });
});

describe("manifestFor", () => {
  test("a local per-agent override wins over the bundled manifest", () => {
    withOverrideDir((overrideDir) => {
      writeFileSync(
        join(overrideDir, "claude.toml"),
        `
[[rules]]
id = "fixture_override"
state = "blocked"
priority = 1
region = "whole_recent"
contains = ["local override evidence"]
`,
      );

      const manifest = manifestFor("claude", { overrideDir });
      expect(manifest).not.toBeNull();
      expect(
        evaluate(
          manifest!,
          grid({ rows: ["local override evidence"], oscTitle: "⠐ bundled would be working" }),
        ),
      ).toEqual({ state: "blocked", ruleId: "fixture_override", fallback: false });
    });
  });

  test("a broken local override is logged and ignored in favor of the bundled manifest", () => {
    withOverrideDir((overrideDir) => {
      writeFileSync(join(overrideDir, "codex.toml"), "[[rules]\nid =");
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const manifest = manifestFor("codex", { overrideDir });
        expect(manifest).not.toBeNull();
        expect(evaluate(manifest!, grid({ oscTitle: "[ ! ] Action Required | repo" })).state).toBe(
          "blocked",
        );
        expect(warning).toHaveBeenCalledTimes(1);
        expect(String(warning.mock.calls[0]?.[0])).toMatch(/override.*ignored/i);
      } finally {
        warning.mockRestore();
      }
    });
  });

  test.each(["future-agent", "constructor", "amp", "goose"])(
    "%s resolves to the generic bundled manifest",
    (agent) => {
      withOverrideDir((overrideDir) => {
        expect(manifestFor(agent, { overrideDir })).toBe(manifestFor("generic", { overrideDir }));
      });
    },
  );

  test("a malformed bundled TOML fixture is a hard module-load error", async () => {
    const bundledModule = join(import.meta.dir, "../../src/detect/manifests/index.ts");
    const malformedToml = "[[rules]]\nid =";
    const probe = `
Bun.plugin({
  name: "broken-bundled-manifest-test",
  setup(build) {
    build.onLoad({ filter: /claude[.]toml$/ }, () => ({
      exports: { default: ${JSON.stringify(malformedToml)} },
      loader: "object",
    }));
  },
});
await import(${JSON.stringify(bundledModule)});
`;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", probe],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(
      /ManifestLoadError: Bundled manifest claude\.toml failed to load: Invalid manifest TOML/i,
    );
  });
});
