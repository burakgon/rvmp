import { describe, expect, test } from "bun:test";
import {
  BLOCKER_REASSERT_MS,
  Classifier,
  HOOK_STATE_FRESH_MS,
  IDLE_CONFIRM_CAP_MS,
  IDLE_CONFIRM_RECHECK_MS,
  IDLE_CONFIRMATIONS,
  STARTUP_GRACE_MS,
  type HookState,
} from "../../src/detect/classifier";
import { AGENT_MISS_LIMIT, type PsSnapshot, type PsSnapshotRow } from "../../src/detect/process-tree";
import type { ScreenGrid } from "../../src/detect/types";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const processRow = (
  overrides: Partial<PsSnapshotRow> & Pick<PsSnapshotRow, "pid">,
): PsSnapshotRow => ({
  ppid: 1,
  pgid: overrides.pid,
  stat: "S",
  command: "unknown",
  ...overrides,
});

const shell = (foreground = false): PsSnapshotRow =>
  processRow({
    pid: 100,
    ppid: 1,
    pgid: 100,
    stat: foreground ? "Ss+" : "Ss",
    command: "/bin/zsh -i",
  });

const liveAgent = (agent = "claude"): PsSnapshot => [
  shell(),
  processRow({ pid: 101, ppid: 100, pgid: 101, stat: "S+", command: agent }),
];

const noChildren = (): PsSnapshot => [shell(true)];

const unrecognizedChild = (): PsSnapshot => [
  shell(true),
  processRow({ pid: 110, ppid: 100, pgid: 110, stat: "S", command: "sleep 30" }),
];

interface Harness {
  classifier: Classifier;
  now(value?: number): number;
  setGrid(rows: string[]): void;
  feed(value?: string): void;
}

function harness(options: {
  agentHint?: string;
  hookState?: HookState | null | (() => HookState | null);
} = {}): Harness {
  let time = 0;
  let nextGrid: ScreenGrid = { rows: [], oscTitle: null, oscProgress: null };
  const classifier = new Classifier({
    ...(options.agentHint === undefined ? {} : { agentHint: options.agentHint }),
    clock: () => time,
    screenGrid: () => ({ ...nextGrid, rows: [...nextGrid.rows] }),
    ...(options.hookState === undefined ? {} : { hookState: options.hookState }),
  });

  return {
    classifier,
    now(value) {
      if (value !== undefined) time = value;
      return time;
    },
    setGrid(rows) {
      nextGrid = { rows: [...rows], oscTitle: null, oscProgress: null };
    },
    feed(value = "") {
      classifier.feed(encode(value));
    },
  };
}

function finishStartup(subject: Harness): void {
  subject.now(STARTUP_GRACE_MS);
}

describe("Classifier constants", () => {
  test("pins the Herdr and Orca arbitration windows", () => {
    expect(STARTUP_GRACE_MS).toBe(3_000);
    expect(IDLE_CONFIRM_RECHECK_MS).toBe(100);
    expect(IDLE_CONFIRMATIONS).toBe(3);
    expect(IDLE_CONFIRM_CAP_MS).toBe(700);
    expect(BLOCKER_REASSERT_MS).toBe(800);
    expect(HOOK_STATE_FRESH_MS).toBe(30 * 60 * 1_000);
  });
});

describe("Classifier precedence", () => {
  test("visible manifest blocker beats a fresh hook and OSC working", () => {
    const subject = harness({
      agentHint: "claude",
      hookState: { state: "working", receivedAt: STARTUP_GRACE_MS },
    });
    finishStartup(subject);
    subject.classifier.observe(100, liveAgent());
    subject.setGrid([
      "tool call",
      "────────",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ]);
    subject.feed("\x1b]2;⠋ claude\x07");

    expect(subject.classifier.sample(subject.now())).toMatchObject({
      agent: "claude",
      state: "blocked",
      ruleId: "numbered_proceed_blocked",
    });
  });

  test("fresh hook beats OSC, OSC beats process-only, and quiet cannot override either", () => {
    let hook: HookState | null = {
      state: "blocked",
      receivedAt: STARTUP_GRACE_MS,
      ruleId: "hook_permission",
    };
    const subject = harness({ agentHint: "claude", hookState: () => hook });
    subject.classifier.observe(100, liveAgent());
    finishStartup(subject);
    subject.setGrid(["ordinary screen"]);
    subject.feed("\x1b]2;⠋ claude\x07");

    expect(subject.classifier.sample(subject.now())).toMatchObject({
      state: "blocked",
      ruleId: "hook_permission",
    });

    hook = null;
    subject.now(3_100);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.now(30_000);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    const processOnly = harness({ agentHint: "codex" });
    processOnly.classifier.observe(100, liveAgent("codex"));
    finishStartup(processOnly);
    expect(processOnly.classifier.sample(processOnly.now()).state).toBe("working");
    processOnly.now(60_000);
    expect(processOnly.classifier.sample(processOnly.now()).state).toBe("working");
  });

  test("OSC working outranks process observations that qualify as idle", () => {
    const subject = harness({ agentHint: "claude" });
    subject.classifier.observe(100, liveAgent());
    finishStartup(subject);
    subject.classifier.observe(100, noChildren());
    subject.classifier.observe(100, noChildren());
    subject.setGrid(["ordinary screen"]);
    subject.feed("\x1b]2;⠋ claude\x07");

    expect(subject.classifier.sample(subject.now()).state).toBe("working");
  });

  test("stale hook state falls through and hook silence is not idle evidence", () => {
    const stale = harness({
      agentHint: "codex",
      hookState: { state: "blocked", receivedAt: 0, ruleId: "stale_hook" },
    });
    stale.classifier.observe(100, liveAgent("codex"));
    stale.now(HOOK_STATE_FRESH_MS + 1);

    expect(stale.classifier.sample(stale.now())).toMatchObject({
      agent: "codex",
      state: "working",
    });
  });
});

describe("Classifier state coordination", () => {
  test("skip_state_update viewer screen freezes the prior state exactly", () => {
    const subject = harness({ agentHint: "claude" });
    subject.classifier.observe(100, liveAgent());
    finishStartup(subject);
    subject.setGrid(["⠋ Working (esc to interrupt)"]);
    subject.feed("\x1b]2;⠋ claude\x07");
    const working = subject.classifier.sample(subject.now());

    subject.now(4_000);
    subject.setGrid(["Showing detailed transcript", "ctrl+o to toggle"]);
    subject.feed("\x1b]2;claude ready\x07");

    expect(subject.classifier.sample(subject.now())).toBe(working);
  });

  test("a stable visible blocker re-asserts every 800ms without resetting since", () => {
    const subject = harness({ agentHint: "claude" });
    finishStartup(subject);
    subject.setGrid([
      "tool call",
      "────────",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ]);
    subject.feed("blocked screen");
    const first = subject.classifier.sample(subject.now());

    subject.now(STARTUP_GRACE_MS + BLOCKER_REASSERT_MS - 1);
    expect(subject.classifier.sample(subject.now())).toBe(first);

    subject.now(STARTUP_GRACE_MS + BLOCKER_REASSERT_MS);
    const reasserted = subject.classifier.sample(subject.now());
    expect(reasserted).not.toBe(first);
    expect(reasserted).toEqual(first);
    expect(reasserted.since).toBe(STARTUP_GRACE_MS);
  });

  test("AgentTracker's confirmed process exit becomes gone", () => {
    const subject = harness({ agentHint: "codex" });
    subject.classifier.observe(100, liveAgent("codex"));
    finishStartup(subject);
    subject.setGrid(["• Working (1s • esc to interrupt)"]);
    subject.feed("last working frame");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    for (let miss = 0; miss < AGENT_MISS_LIMIT; miss += 1) {
      subject.now(3_100 + miss * 100);
      subject.classifier.observe(100, noChildren());
    }

    expect(subject.classifier.sample(subject.now())).toMatchObject({
      agent: null,
      state: "gone",
    });
  });

  test("3 second startup grace publishes idle and suppresses early flips", () => {
    const subject = harness({ agentHint: "codex" });
    subject.classifier.observe(100, liveAgent("codex"));
    subject.setGrid(["• Working (1s • esc to interrupt)"]);
    subject.feed("frame");

    subject.now(STARTUP_GRACE_MS - 1);
    expect(subject.classifier.sample(subject.now())).toMatchObject({
      agent: "codex",
      state: "idle",
      since: 0,
    });

    subject.now(STARTUP_GRACE_MS);
    expect(subject.classifier.sample(subject.now())).toMatchObject({
      agent: "codex",
      state: "working",
      since: STARTUP_GRACE_MS,
    });
  });

  test("requires repeated idle evidence and vetoes a process-exit idle while any child remains", () => {
    const subject = harness({ agentHint: "opencode" });
    subject.classifier.observe(100, liveAgent("opencode"));
    finishStartup(subject);
    subject.setGrid(["⠋ Working (esc to interrupt)"]);
    subject.feed("working frame");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.classifier.observe(100, unrecognizedChild());
    subject.setGrid(["conversation", "────────", "  ❯ ", "────────"]);
    subject.feed("idle redraw");
    subject.now(3_100);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    subject.now(3_200);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.classifier.observe(100, noChildren());
    subject.now(3_300);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    subject.classifier.observe(100, noChildren());
    subject.now(3_400);
    expect(subject.classifier.sample(subject.now())).toMatchObject({
      agent: "opencode",
      state: "idle",
      since: 3_400,
      ruleId: "prompt_box_idle",
    });
  });

  test("requires two distinct qualifying process observations before idle", () => {
    const subject = harness({ agentHint: "opencode" });
    subject.classifier.observe(100, liveAgent("opencode"));
    finishStartup(subject);
    subject.setGrid(["⠋ Working (esc to interrupt)"]);
    subject.feed("working frame");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.classifier.observe(100, noChildren());
    subject.setGrid(["conversation", "────────", "  ❯ ", "────────"]);
    subject.feed("idle redraw");
    subject.now(3_100);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.classifier.observe(100, noChildren());
    expect(subject.classifier.sample(subject.now()).state).toBe("idle");
  });

  test("plain fallback idle uses Herdr's 100ms x3 hold and 700ms cap", () => {
    const subject = harness({ agentHint: "codex" });
    subject.classifier.observe(100, liveAgent("codex"));
    finishStartup(subject);
    subject.setGrid(["• Working (1s • esc to interrupt)"]);
    subject.feed("working");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.setGrid(["unrecognized Codex screen"]);
    subject.feed("redraw");
    for (const now of [3_100, 3_200, 3_300]) {
      subject.now(now);
      expect(subject.classifier.sample(subject.now()).state).toBe("working");
    }
    subject.now(3_400);
    expect(subject.classifier.sample(subject.now()).state).toBe("idle");

    subject.setGrid(["• Working (2s • esc to interrupt)"]);
    subject.feed("working again");
    subject.now(4_000);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    subject.setGrid(["unrecognized Codex screen"]);
    subject.feed("redraw again");
    subject.now(4_100);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    subject.now(4_800);
    expect(subject.classifier.sample(subject.now()).state).toBe("idle");
  });

  test("a title working signal cancels a pending idle-to-done transition", () => {
    let hook: HookState | null = null;
    const subject = harness({ agentHint: "claude", hookState: () => hook });
    subject.classifier.observe(100, liveAgent());
    finishStartup(subject);
    subject.setGrid(["ordinary screen"]);
    subject.feed("\x1b]2;⠋ claude\x07");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.classifier.observe(100, noChildren());
    hook = { state: "idle", receivedAt: 3_100, ruleId: "hook_done" };
    subject.feed("\x1b]2;claude ready\x07");
    subject.now(3_100);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.feed("\x1b]2;⠋ claude\x07");
    subject.now(3_200);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.feed("\x1b]2;claude ready\x07");
    subject.classifier.observe(100, noChildren());
    subject.now(3_300);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    subject.classifier.observe(100, noChildren());
    subject.now(3_400);
    expect(subject.classifier.sample(subject.now()).state).toBe("idle");
  });

  test("a manifest screen working signal cancels a pending idle-to-done transition", () => {
    let hook: HookState | null = null;
    const subject = harness({ agentHint: "codex", hookState: () => hook });
    subject.classifier.observe(100, liveAgent("codex"));
    finishStartup(subject);
    subject.setGrid(["• Working (1s • esc to interrupt)"]);
    subject.feed("working frame");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.classifier.observe(100, noChildren());
    hook = { state: "idle", receivedAt: 3_100, ruleId: "hook_done" };
    subject.setGrid(["unrecognized Codex screen"]);
    subject.feed("idle redraw");
    subject.now(3_100);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.setGrid(["• Working (2s • esc to interrupt)"]);
    subject.feed("working redraw");
    subject.now(3_200);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.setGrid(["unrecognized Codex screen"]);
    subject.feed("idle redraw again");
    subject.classifier.observe(100, noChildren());
    subject.now(3_300);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    subject.classifier.observe(100, noChildren());
    subject.now(3_400);
    expect(subject.classifier.sample(subject.now()).state).toBe("idle");
  });

  test("uses the spawn hint, confirms it, and lets specific process evidence refine it", () => {
    const subject = harness({ agentHint: "claude" });
    expect(subject.classifier.sample(subject.now())).toMatchObject({ agent: "claude", state: "idle" });

    subject.classifier.observe(100, liveAgent("claude"));
    subject.now(STARTUP_GRACE_MS);
    expect(subject.classifier.sample(subject.now()).agent).toBe("claude");

    subject.classifier.observe(100, liveAgent("codex"));
    expect(subject.classifier.sample(subject.now())).toMatchObject({ agent: "codex", state: "idle" });
    subject.now(2 * STARTUP_GRACE_MS);
    expect(subject.classifier.sample(subject.now())).toMatchObject({ agent: "codex", state: "working" });

    subject.classifier.observe(100, [
      shell(),
      processRow({ pid: 102, ppid: 100, pgid: 102, stat: "S+", command: "opaque-wrapper" }),
    ]);
    expect(subject.classifier.sample(subject.now()).agent).toBe("codex");
  });
});

describe("Classifier banned-path lock", () => {
  test("changing spinner rows remain working", () => {
    const subject = harness({ agentHint: "codex" });
    subject.classifier.observe(100, liveAgent("codex"));
    finishStartup(subject);

    for (const [index, spinner] of ["•", "◦", "•"].entries()) {
      subject.setGrid([`${spinner} Working (${index + 1}s • esc to interrupt)`]);
      subject.feed(`spinner frame ${index}`);
      subject.now(STARTUP_GRACE_MS + index * 100);
      expect(subject.classifier.sample(subject.now()).state).toBe("working");
    }
  });

  test("feeding nothing while the retained screen is working stays working", () => {
    const subject = harness({ agentHint: "codex" });
    subject.classifier.observe(100, liveAgent("codex"));
    finishStartup(subject);
    subject.setGrid(["• Working (1s • esc to interrupt)"]);
    subject.feed("initial frame");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.now(60_000);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
  });

  test("only an idle screen change plus two no-child samples confirms idle", () => {
    const subject = harness({ agentHint: "opencode" });
    subject.classifier.observe(100, liveAgent("opencode"));
    finishStartup(subject);
    subject.setGrid(["⠋ Working (esc to interrupt)"]);
    subject.feed("working frame");
    expect(subject.classifier.sample(subject.now()).state).toBe("working");

    subject.classifier.observe(100, noChildren());
    subject.setGrid(["conversation", "────────", "  ❯ ", "────────"]);
    subject.feed("idle screen frame");
    subject.now(3_100);
    expect(subject.classifier.sample(subject.now()).state).toBe("working");
    subject.classifier.observe(100, noChildren());
    subject.now(3_200);
    expect(subject.classifier.sample(subject.now()).state).toBe("idle");
  });

  test("byte activity with an unchanged idle grid cannot synthesize working", () => {
    const subject = harness({ agentHint: "claude" });
    subject.classifier.observe(100, liveAgent());
    finishStartup(subject);
    subject.setGrid(["conversation", "────────", "  ❯ ", "────────"]);
    subject.feed("idle frame");
    subject.now(3_100);
    subject.classifier.sample(subject.now());
    subject.now(3_200);
    expect(subject.classifier.sample(subject.now()).state).toBe("idle");

    for (const now of [3_300, 3_400, 3_500]) {
      subject.feed(`raw redraw bytes ${now}`);
      subject.now(now);
      expect(subject.classifier.sample(subject.now()).state).toBe("idle");
    }
  });
});
