import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attempt, Card, Dispatch, Project, SessionMeta } from "@codegent/protocol";
import type { OpenSessionOpts } from "../src/pty/manager";
import { ClaudeAdapter, buildTaskPrompt, normalizeClaudeHook } from "../src/agents/claude";
import { injectTaskPrompt } from "../src/agents/common";
import type { AdapterPtySession, AdapterPtys, AdapterSignal, SpawnCtx } from "../src/agents/types";

const dataDir = mkdtempSync(join(tmpdir(), "cg-claude-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures/cc-hooks", name), "utf8"));

// ---------------------------------------------------------------------------
// Normalizer: fixture → signal table (payloads are byte-exact spike captures,
// docs/research/tmp/cc-hook-spike — the live-verified CC 2.1.215 contract).
// ---------------------------------------------------------------------------

const TABLE: Array<[string, AdapterSignal[]]> = [
  ["session-start-startup.json", [{ s: "session-started", adapterSessionId: "9292fcdb-c90f-474c-9367-11e1a9ff7c72" }]],
  ["session-start-resume.json", [{ s: "session-started", adapterSessionId: "1c1a9491-a5d3-4bd5-b169-4914a8ffc0f2" }]],
  ["permission-request.json", [{ s: "flag", kind: "permission" }]],
  // AskUserQuestion's own PermissionRequest reclassifies to question — it lands
  // ~18ms after the PreToolUse flag and must not flip the sub-chip to permission:
  ["permissionrequest-askuserquestion.json", [{ s: "flag", kind: "question" }]],
  ["pretooluse-askuserquestion.json", [{ s: "flag", kind: "question" }]],
  ["posttooluse-askuserquestion.json", [{ s: "flag-clear" }]],
  ["stop.json", [{ s: "complete-eval" }]],
  ["stop-failure.json", [{ s: "stop-failure" }]],
  // Unregistered/unknown events fail open — real payloads, deliberately unmapped:
  ["notification.json", []], // Notification is dropped by design (contract doc claim 4)
  ["session-end.json", []],
  ["pretooluse-bash.json", []], // non-AskUserQuestion tool events carry no signal
  ["posttooluse-bash.json", []],
];

for (const [file, want] of TABLE) {
  test(`normalize ${file} → ${JSON.stringify(want)}`, () => {
    expect(normalizeClaudeHook(fx(file))).toEqual(want);
  });
}

test("normalizer is pure: same input twice, input not mutated", () => {
  const ev = fx("stop.json");
  const snapshot = JSON.stringify(ev);
  expect(normalizeClaudeHook(ev)).toEqual(normalizeClaudeHook(ev));
  expect(JSON.stringify(ev)).toBe(snapshot);
});

test("malformed events fail open to []", () => {
  expect(normalizeClaudeHook(null)).toEqual([]);
  expect(normalizeClaudeHook(42)).toEqual([]);
  expect(normalizeClaudeHook("Stop")).toEqual([]);
  expect(normalizeClaudeHook({})).toEqual([]);
  expect(normalizeClaudeHook({ hook_event_name: 99 })).toEqual([]);
  expect(normalizeClaudeHook({ hook_event_name: "TotallyNewEvent" })).toEqual([]);
  // SessionStart without a usable session_id cannot signal session-started:
  expect(normalizeClaudeHook({ hook_event_name: "SessionStart" })).toEqual([]);
  expect(normalizeClaudeHook({ hook_event_name: "SessionStart", session_id: "" })).toEqual([]);
});

// ---------------------------------------------------------------------------
// Prompt template (pure)
// ---------------------------------------------------------------------------

test("buildTaskPrompt carries title, body, envelope ids, and the completion preamble", () => {
  const p = buildTaskPrompt({
    title: "Fix the login bug",
    body: "Steps:\n1. reproduce\n2. fix",
    cardId: 7,
    attemptId: 3,
    dispatchId: "d-123",
  });
  expect(p).toContain("Fix the login bug");
  expect(p).toContain("1. reproduce\n2. fix");
  expect(p).toContain("card 7");
  expect(p).toContain("attempt 3");
  expect(p).toContain("dispatch d-123");
  expect(p).toContain("task_complete");
  expect(p).toContain("task_progress");
  expect(p).toContain("exactly once");
});

test("buildTaskPrompt sanitizes control bytes and never itself contains CR", () => {
  const p = buildTaskPrompt({
    title: "T\x1b[31m",
    body: "line1\r\nline2\rline3\x07",
    cardId: 1,
    attemptId: 2,
    dispatchId: "d",
  });
  expect(p).not.toContain("\r"); // the ONLY \r ever written is the separate submit
  expect(p).not.toContain("\x1b");
  expect(p).not.toContain("\x07");
  expect(p).toContain("line1\nline2\nline3"); // newlines normalized, not lost
});

test("buildTaskPrompt with an empty body leaves no gap", () => {
  const p = buildTaskPrompt({ title: "T", body: "  ", cardId: 1, attemptId: 2, dispatchId: "d" });
  expect(p).not.toContain("\n\n\n");
  expect(p).toContain("T");
});

// ---------------------------------------------------------------------------
// Spawn: settings.json / mcp.json goldens, argv per mode, prompt injection
// ---------------------------------------------------------------------------

class FakeSession implements AdapterPtySession {
  constructor(private sink: string[], readonly pid = 0) {}
  write(d: Uint8Array | string): void {
    this.sink.push(typeof d === "string" ? d : new TextDecoder().decode(d));
  }
  onData(cb: (b: Uint8Array) => void): () => void {
    // One async chunk ≈ the CLI's first paint; then quiet — the adapter's
    // paste-readiness gate must resolve on the quiet window after it.
    const t = setTimeout(() => cb(new TextEncoder().encode("banner")), 5);
    return () => clearTimeout(t);
  }
}

class FakePtys {
  opened: OpenSessionOpts[] = [];
  writes: string[] = [];
  metas: SessionMeta[] = [];
  pid = 0;
  dead = false; // when true, get() finds nothing (session died instantly)
  private sessions = new Map<string, FakeSession>();
  open(opts: OpenSessionOpts): SessionMeta {
    this.opened.push(opts);
    const id = `pty-${this.opened.length}`;
    const meta: SessionMeta = {
      id, projectId: opts.projectId, kind: opts.kind ?? "shell", title: opts.title,
      cwd: opts.cwd, worktreeId: opts.worktreeId ?? null, live: true, createdAt: Date.now(),
      adapterSessionId: null, attemptId: opts.attemptId ?? null,
    };
    this.metas.push(meta);
    this.sessions.set(id, new FakeSession(this.writes, this.pid));
    return meta;
  }
  get(id: string): FakeSession | undefined {
    return this.dead ? undefined : this.sessions.get(id);
  }
}

const project: Project = { id: "p1", name: "proj", path: "/tmp/proj", baseBranch: "main", createdAt: 1, workerLimit: 1 };
const card: Card = {
  id: 7, projectId: "p1", title: "Fix the login bug", body: "Steps:\n1. reproduce\n2. fix",
  phase: "working", agent: "claude", worktreeId: "wt1", position: 1, createdAt: 1, updatedAt: 1,
  workingSub: "starting", errorKind: null, reviewSub: null, inputKind: null, inputSince: null,
  round: 1, auto: true, attemptId: 3,
};
const attempt: Attempt = { id: 3, cardId: 7, worktreeId: "wt1", seq: 1, status: "running", beforeHead: null, createdAt: 1 };
const dispatch: Dispatch = { id: "d-123", attemptId: 3, status: "running", lastProgressAt: null, createdAt: 1 };

const HOOK_PORT = 45678;
const HOOK_TOKEN = "tok-abc";
// Tight timings so tests stay fast; production defaults are separate constants.
const TIMING = { capMs: 300, minReadyMs: 0, quietMs: 20, enterDelayMs: 10 };

function makeAdapter(ptys: FakePtys) {
  return new ClaudeAdapter({ dataDir, hookPort: HOOK_PORT, hookToken: HOOK_TOKEN, ptys, timing: TIMING });
}

function ctx(over: Partial<SpawnCtx> = {}): SpawnCtx {
  return { project, card, attempt, dispatch, worktreePath: "/tmp/wt", mode: "ask", ...over };
}

test("spawn writes the six-event settings.json — recorded shape, no Notification", async () => {
  const ptys = new FakePtys();
  const res = await makeAdapter(ptys).spawn(ctx());

  expect(res.settingsDir).toBe(join(dataDir, "agents", "d-123"));
  expect(statSync(res.settingsDir).mode & 0o777).toBe(0o700);
  const settingsPath = join(res.settingsDir, "settings.json");
  expect(statSync(settingsPath).mode & 0o777).toBe(0o600);

  const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
  const hooks = cfg.hooks as Record<string, Array<Record<string, unknown>>>;
  expect(Object.keys(hooks).sort()).toEqual([
    "PermissionRequest", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "StopFailure",
  ]);
  expect(hooks.Notification).toBeUndefined();

  // Hook command: session identity baked into the command string itself
  // (survives claude's env filtering), forwarder = T6's hook.sh + agent arg.
  const wantCmd = `CODEGENT_SESSION_ID='d-123' '${join(dataDir, "agents", "hook.sh")}' claude`;
  for (const [event, entries] of Object.entries(hooks)) {
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    if (event === "PreToolUse" || event === "PostToolUse") {
      expect(entry.matcher).toBe("AskUserQuestion"); // tool-name matcher (contract doc claim 3)
    } else {
      expect("matcher" in entry).toBe(false); // recorded working config: no matcher key
    }
    expect(entry.hooks).toEqual([{ type: "command", command: wantCmd }]);
  }

  // The forwarder itself was (re)written next to the per-dispatch dir:
  expect(statSync(join(dataDir, "agents", "hook.sh")).mode & 0o777).toBe(0o755);
});

test("spawn writes mcp.json wiring the sidecar with the dispatch envelope", async () => {
  const ptys = new FakePtys();
  const res = await makeAdapter(ptys).spawn(ctx());

  const mcpPath = join(res.settingsDir, "mcp.json");
  expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  const entry = join(import.meta.dir, "../src/agents/mcp-entry.ts");
  expect(existsSync(entry)).toBe(true); // the args target must actually exist
  expect(mcp).toEqual({
    mcpServers: {
      codegent: {
        command: "bun",
        args: [entry],
        env: {
          CODEGENT_HOOK_PORT: String(HOOK_PORT),
          CODEGENT_HOOK_TOKEN: HOOK_TOKEN,
          CODEGENT_CARD_ID: "7",
          CODEGENT_DISPATCH_ID: "d-123",
        },
      },
    },
  });
});

test("spawn records the process group before prompt readiness work completes", async () => {
  const ptys = new FakePtys();
  ptys.pid = process.pid;
  const earlyDispatch = { ...dispatch, id: "d-early-marker-claude" };
  const settingsDir = join(dataDir, "agents", earlyDispatch.id);

  const spawning = makeAdapter(ptys).spawn(ctx({ dispatch: earlyDispatch }));
  const markerBeforeReadiness = existsSync(join(settingsDir, ".codegent-process-group.json"));
  const writesBeforeReadiness = [...ptys.writes];
  await spawning;

  expect(markerBeforeReadiness).toBe(true);
  expect(writesBeforeReadiness).toEqual([]);
});

test("spawn argv: ask mode = bare verified injection path (no mode flags)", async () => {
  const ptys = new FakePtys();
  const res = await makeAdapter(ptys).spawn(ctx({ mode: "ask" }));
  expect(ptys.opened[0]!.cmd).toEqual([
    "claude",
    "--settings", join(res.settingsDir, "settings.json"),
    "--setting-sources", "project",
    "--mcp-config", join(res.settingsDir, "mcp.json"),
  ]);
});

test("spawn argv: host mode adds --dangerously-skip-permissions", async () => {
  const ptys = new FakePtys();
  await makeAdapter(ptys).spawn(ctx({ mode: "host" }));
  const cmd = ptys.opened[0]!.cmd!;
  expect(cmd).toContain("--dangerously-skip-permissions");
  expect(cmd).not.toContain("--permission-mode");
});

test("spawn argv: auto mode adds --permission-mode auto (CC native sandbox mode)", async () => {
  const ptys = new FakePtys();
  await makeAdapter(ptys).spawn(ctx({ mode: "auto" }));
  const cmd = ptys.opened[0]!.cmd!;
  const i = cmd.indexOf("--permission-mode");
  expect(i).toBeGreaterThan(0);
  expect(cmd[i + 1]).toBe("auto");
  expect(cmd).not.toContain("--dangerously-skip-permissions");
});

test("spawn argv: resumeSessionId appends --resume <id> after mode flags", async () => {
  const ptys = new FakePtys();
  await makeAdapter(ptys).spawn(ctx({ mode: "host", resumeSessionId: "9292fcdb-c90f-474c-9367-11e1a9ff7c72" }));
  const cmd = ptys.opened[0]!.cmd!;
  expect(cmd.slice(-2)).toEqual(["--resume", "9292fcdb-c90f-474c-9367-11e1a9ff7c72"]);
  expect(cmd.indexOf("--dangerously-skip-permissions")).toBeLessThan(cmd.indexOf("--resume"));
});

test("spawn argv: no --resume without a resumeSessionId (null included)", async () => {
  const ptys = new FakePtys();
  await makeAdapter(ptys).spawn(ctx({ resumeSessionId: null }));
  expect(ptys.opened[0]!.cmd).not.toContain("--resume");
});

test("spawn opens an agent-kind PTY in the worktree with scrubbed env + CODEGENT_*", async () => {
  process.env.CLAUDE_PROBE = "leak"; // simulates running the daemon inside a CC session
  try {
    const ptys = new FakePtys();
    const res = await makeAdapter(ptys).spawn(ctx());
    const o = ptys.opened[0]!;
    expect(o.kind).toBe("agent");
    expect(o.cwd).toBe("/tmp/wt");
    expect(o.projectId).toBe("p1");
    expect(o.worktreeId).toBe("wt1");
    expect(o.attemptId).toBe(3);
    expect(o.title).toBe("Fix the login bug");
    const env = o.env!;
    expect(env.CODEGENT_SESSION_ID).toBe("d-123");
    expect(env.CODEGENT_HOOK_PORT).toBe(String(HOOK_PORT));
    expect(env.CODEGENT_HOOK_TOKEN).toBe(HOOK_TOKEN);
    expect(env.TERM).toBe("xterm-256color");
    expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE"))).toEqual([]);
    expect(res.sessionMeta).toEqual(ptys.metas[0]!);
  } finally {
    delete process.env.CLAUDE_PROBE;
  }
});

test("spawn injects the prompt \\x15-first, then a separate \\r submit (Orca paste rule)", async () => {
  const ptys = new FakePtys();
  await makeAdapter(ptys).spawn(ctx());
  expect(ptys.writes).toHaveLength(2);
  const [paste, enter] = ptys.writes;
  expect(paste!.startsWith("\x15")).toBe(true); // Ctrl+U first: CC restores interrupted prompts
  expect(paste!).toContain("Fix the login bug");
  expect(paste!).toContain("dispatch d-123");
  expect(paste!).toContain("task_complete");
  expect(paste!).not.toContain("\r"); // a \r inside a large write is swallowed as paste
  expect(enter).toBe("\r"); // the submit travels alone, after the paste settles
  // Overall framing: \x15 … \r
  const all = ptys.writes.join("");
  expect(all.startsWith("\x15")).toBe(true);
  expect(all.endsWith("\r")).toBe(true);
});

test("prompt injection ignores an early first-paint gap before the composer is ready", async () => {
  const writes: string[] = [];
  let ready = false;
  const sess: AdapterPtySession = {
    pid: 0,
    write(data) {
      if (ready) writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    onData(cb) {
      const early = setTimeout(() => cb(new TextEncoder().encode("early paint")), 2);
      const composer = setTimeout(() => {
        ready = true;
        cb(new TextEncoder().encode("composer"));
      }, 40);
      return () => { clearTimeout(early); clearTimeout(composer); };
    },
  };
  const ptys: AdapterPtys = {
    open: () => { throw new Error("not used"); },
    get: () => sess,
  };

  await injectTaskPrompt(ptys, "pty", "Task: wait for the composer", {
    capMs: 120, minReadyMs: 55, quietMs: 10, enterDelayMs: 1,
  });

  expect(writes).toEqual(["\x15Task: wait for the composer", "\r"]);
});

test("spawn survives a session that died before injection (no writes, still resolves)", async () => {
  const ptys = new FakePtys();
  ptys.dead = true;
  const res = await makeAdapter(ptys).spawn(ctx());
  expect(res.sessionMeta.id).toBe("pty-1");
  expect(ptys.writes).toEqual([]);
});

test("adapter identity and onHook delegation to the pure normalizer", () => {
  const a = makeAdapter(new FakePtys());
  expect(a.agent).toBe("claude");
  expect(a.onHook("d-123", fx("stop.json"))).toEqual([{ s: "complete-eval" }]);
  expect(a.onHook("d-123", fx("notification.json"))).toEqual([]);
});
