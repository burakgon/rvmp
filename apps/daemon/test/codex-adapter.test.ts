import { test, expect, afterAll } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attempt, Card, Dispatch, Project, SessionMeta } from "@rvmp/protocol";
import type { OpenSessionOpts } from "../src/pty/manager";
import { CodexAdapter, codexSessionsStore, normalizeCodexHook } from "../src/agents/codex";
import type { AdapterPtySession, AdapterSignal, SpawnCtx } from "../src/agents/types";

// ---------------------------------------------------------------------------
// Harness — mirrors claude-adapter.test.ts: fake PTY plane, per-test tmp dirs.
// The USER codex home is a fixture dir; the adapter must only ever READ it.
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});
const mkTmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
};

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures/codex-hooks", name), "utf8"));

class FakeSession implements AdapterPtySession {
  constructor(private sink: string[], readonly pid = 0) {}
  write(d: Uint8Array | string): void {
    this.sink.push(typeof d === "string" ? d : new TextDecoder().decode(d));
  }
  onData(cb: (b: Uint8Array) => void): () => void {
    // One async chunk ≈ the TUI's first paint; then quiet — the adapter's
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
    return this.sessions.get(id);
  }
}

const project: Project = { id: "p1", name: "proj", path: "/tmp/proj", baseBranch: "main", createdAt: 1, workerLimit: 1, defaultAgent: null, setupScript: "", copyGlobs: [], mode: "auto" };
const cardRow: Card = {
  id: 7, projectId: "p1", title: "Fix the login bug", body: "Steps:\n1. reproduce\n2. fix",
  phase: "working", agent: "codex", worktreeId: "wt1", position: 1, createdAt: 1, updatedAt: 1,
  workingSub: "starting", errorKind: null, reviewSub: null, inputKind: null, inputSince: null,
  round: 1, auto: true, attemptId: 3, executionMode: "inherit",
  readySince: null, mergeSha: null, prNumber: null, prUrl: null, prState: null, ciStatus: null,
};
const attempt: Attempt = { id: 3, cardId: 7, worktreeId: "wt1", seq: 1, status: "running", beforeHead: null, createdAt: 1 };
const dispatch: Dispatch = { id: "d-123", attemptId: 3, status: "running", lastProgressAt: null, createdAt: 1 };

const HOOK_PORT = 45678;
const HOOK_TOKEN = "tok-abc";
const TIMING = { capMs: 300, minReadyMs: 0, quietMs: 20, enterDelayMs: 10 };

/** A fixture USER ~/.codex — realistic config.toml + auth.json, mtimes pinned
 * into the past so any accidental write is unmissable. */
function makeUserHome(): string {
  const dir = mkTmp("cg-user-codex-");
  writeFileSync(join(dir, "config.toml"), [
    `model = "gpt-5.6-sol"`,
    `model_reasoning_effort = "low"`,
    ``,
    `[projects."/Users/someone/own-repo"]`,
    `trust_level = "trusted"`,
    ``,
  ].join("\n"));
  writeFileSync(join(dir, "auth.json"), `{"OPENAI_API_KEY":null,"tokens":{"access_token":"fixture"}}`);
  const past = new Date(Date.now() - 86_400_000);
  utimesSync(join(dir, "config.toml"), past, past);
  utimesSync(join(dir, "auth.json"), past, past);
  utimesSync(dir, past, past);
  return dir;
}

function makeWorld(over: { userCodexDir?: string | null } = {}) {
  const dataDir = mkTmp("cg-codex-");
  const userCodexDir = over.userCodexDir === undefined ? makeUserHome() : over.userCodexDir;
  const ptys = new FakePtys();
  const adapter = new CodexAdapter({
    dataDir, hookPort: HOOK_PORT, hookToken: HOOK_TOKEN, ptys, timing: TIMING,
    // null → point at a nonexistent dir (a user with no ~/.codex at all).
    userCodexDir: userCodexDir ?? join(dataDir, "no-such-home"),
  });
  return { dataDir, userCodexDir, ptys, adapter };
}

function ctx(over: Partial<SpawnCtx> = {}): SpawnCtx {
  return { project, card: cardRow, attempt, dispatch, worktreePath: "/tmp/wt", mode: "ask", ...over };
}

/** The per-dispatch CODEX_HOME the adapter builds for a spawn. */
const homeOf = (dataDir: string, dispatchId: string): string =>
  join(dataDir, "agents", dispatchId);

test("spawn records the process group before prompt readiness work completes", async () => {
  const { dataDir, ptys, adapter } = makeWorld({ userCodexDir: null });
  ptys.pid = process.pid;
  const earlyDispatch = { ...dispatch, id: "d-early-marker-codex" };
  const settingsDir = homeOf(dataDir, earlyDispatch.id);

  const spawning = adapter.spawn(ctx({ dispatch: earlyDispatch }));
  const markerBeforeReadiness = existsSync(join(settingsDir, ".rvmp-process-group.json"));
  const writesBeforeReadiness = [...ptys.writes];
  await spawning;

  expect(markerBeforeReadiness).toBe(true);
  expect(writesBeforeReadiness).toEqual([]);
});

// ---------------------------------------------------------------------------
// Normalizer: fixture → signal table. All payloads under fixtures/codex-hooks/
// are REAL trimmed captures from the live spike (docs/research/tmp/
// cc-hook-spike/logs/events-c1_codex_tui.jsonl + events-c2_codex_resume.jsonl,
// codex-cli 0.144.6).
// ---------------------------------------------------------------------------

const SPIKE_SID = "019f7b26-6e6e-7132-855d-23e0de0949dc";

const TABLE: Array<[string, AdapterSignal[]]> = [
  ["session-start-startup.json", [{ s: "session-started", adapterSessionId: SPIKE_SID }]],
  // c2: resume fires SessionStart(source:"resume") with the SAME session id.
  ["session-start-resume.json", [{ s: "session-started", adapterSessionId: SPIKE_SID }]],
  ["permission-request.json", [{ s: "flag", kind: "permission" }]],
  ["stop.json", [{ s: "complete-eval" }]],
  // No signal value — codex has no AskUserQuestion-equivalent (contract doc
  // claim 7b: Claude-style exec tool naming only), so question turns land via
  // Stop-without-complete at the engine's truth table, not via tool events:
  ["user-prompt-submit.json", []],
  ["pretooluse-bash.json", []],
  ["posttooluse-bash.json", []],
];

for (const [file, want] of TABLE) {
  test(`normalize ${file} → ${JSON.stringify(want)}`, () => {
    expect(normalizeCodexHook(fx(file))).toEqual(want);
  });
}

test("events that DO NOT EXIST in codex 0.144.6 fail open to [] (SYNTHETIC-per-doc shapes)", () => {
  // SYNTHETIC-per-doc: the spike never captured these BECAUSE codex has no
  // such events (contract doc claim 7a: "No SessionEnd, no Notification, no
  // StopFailure"); shapes below are derived from the doc's recorded common-key
  // schema (session_id/model/permission_mode on every event) purely to prove
  // the normalizer cannot misfire on them.
  const common = { session_id: SPIKE_SID, model: "gpt-5.6-sol", permission_mode: "default" };
  expect(normalizeCodexHook({ ...common, hook_event_name: "StopFailure", error: "unknown" })).toEqual([]);
  expect(normalizeCodexHook({ ...common, hook_event_name: "SessionEnd", reason: "other" })).toEqual([]);
  expect(normalizeCodexHook({ ...common, hook_event_name: "Notification", message: "x" })).toEqual([]);
  // Registered-but-uncaptured events (SYNTHETIC-per-doc, claim 7a event list):
  expect(normalizeCodexHook({ ...common, hook_event_name: "SubagentStart" })).toEqual([]);
  expect(normalizeCodexHook({ ...common, hook_event_name: "SubagentStop" })).toEqual([]);
  expect(normalizeCodexHook({ ...common, hook_event_name: "PreCompact" })).toEqual([]);
  expect(normalizeCodexHook({ ...common, hook_event_name: "PostCompact" })).toEqual([]);
});

test("malformed events fail open to []", () => {
  expect(normalizeCodexHook(null)).toEqual([]);
  expect(normalizeCodexHook(42)).toEqual([]);
  expect(normalizeCodexHook("Stop")).toEqual([]);
  expect(normalizeCodexHook({})).toEqual([]);
  expect(normalizeCodexHook({ hook_event_name: 99 })).toEqual([]);
  expect(normalizeCodexHook({ hook_event_name: "SessionStart" })).toEqual([]);
  expect(normalizeCodexHook({ hook_event_name: "SessionStart", session_id: "" })).toEqual([]);
});

test("normalizer is pure: same input twice, input not mutated", () => {
  const ev = fx("stop.json");
  const snapshot = JSON.stringify(ev);
  expect(normalizeCodexHook(ev)).toEqual(normalizeCodexHook(ev));
  expect(JSON.stringify(ev)).toBe(snapshot);
});

// ---------------------------------------------------------------------------
// Lazy firing (contract doc claim 7b): TUI session hooks fire at the FIRST
// prompt submit. SessionStart still precedes everything in the captures, but
// the transport is fail-open — if it drops, the first event seen must double
// as session-started (session_id is in EVERY payload).
// ---------------------------------------------------------------------------

test("onHook synthesizes session-started when the first event for a spawn key is not SessionStart", () => {
  const { adapter } = makeWorld({ userCodexDir: null });
  expect(adapter.onHook("d-1", fx("stop.json"))).toEqual([
    { s: "session-started", adapterSessionId: SPIKE_SID },
    { s: "complete-eval" },
  ]);
  // Second event for the same key: no re-synthesis.
  expect(adapter.onHook("d-1", fx("stop.json"))).toEqual([{ s: "complete-eval" }]);
});

test("onHook does NOT double session-started when SessionStart arrives first (the recorded order)", () => {
  const { adapter } = makeWorld({ userCodexDir: null });
  expect(adapter.onHook("d-2", fx("session-start-startup.json"))).toEqual([
    { s: "session-started", adapterSessionId: SPIKE_SID },
  ]);
  expect(adapter.onHook("d-2", fx("user-prompt-submit.json"))).toEqual([]);
  expect(adapter.onHook("d-2", fx("stop.json"))).toEqual([{ s: "complete-eval" }]);
});

test("onHook synthesis needs a usable session_id and re-arms per spawn key", () => {
  const { adapter } = makeWorld({ userCodexDir: null });
  // Malformed first event: nothing to synthesize from, key stays unarmed…
  expect(adapter.onHook("d-3", { hook_event_name: "Stop" })).toEqual([{ s: "complete-eval" }]);
  // …so the next event with a session_id still synthesizes.
  expect(adapter.onHook("d-3", fx("permission-request.json"))).toEqual([
    { s: "session-started", adapterSessionId: SPIKE_SID },
    { s: "flag", kind: "permission" },
  ]);
  // A DIFFERENT spawn key (codex resume = new dispatch) re-arms independently.
  expect(adapter.onHook("d-4", fx("session-start-resume.json"))).toEqual([
    { s: "session-started", adapterSessionId: SPIKE_SID },
  ]);
});

// ---------------------------------------------------------------------------
// Per-dispatch CODEX_HOME generation (spawn-time build)
// ---------------------------------------------------------------------------

test("spawn builds the per-dispatch home: user config copied + trust + MCP entry, auth copied, hooks.json valid — parseable TOML", async () => {
  const { dataDir, userCodexDir, ptys, adapter } = makeWorld();
  const wt = mkTmp("cg-wt-"); // real dir so the realpath trust entry exists
  const res = await adapter.spawn(ctx({ worktreePath: wt }));

  const home = homeOf(dataDir, "d-123"); // dispatch-keyed, like claude's dir
  expect(res.settingsDir).toBe(home);
  expect(statSync(home).mode & 0o777).toBe(0o700);

  // sessions is a SYMLINK into the one shared rollout store (durable; the
  // settings GC sweeps the home but rollouts must outlive every dispatch).
  const link = join(home, "sessions");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(realpathSync(link)).toBe(realpathSync(codexSessionsStore(dataDir)));

  // config.toml: the user's copy verbatim at the top + the managed block.
  const cfgText = readFileSync(join(home, "config.toml"), "utf8");
  expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
  expect(cfgText.startsWith(`model = "gpt-5.6-sol"`)).toBe(true);
  const cfg = (Bun as any).TOML.parse(cfgText) as any; // must PARSE — merged file is valid TOML
  expect(cfg.model).toBe("gpt-5.6-sol");
  expect(cfg.projects["/Users/someone/own-repo"].trust_level).toBe("trusted"); // user entry survives
  // Trust: literal worktree path, plus its realpath when the two differ
  // (macOS: /var/folders → /private/var/folders — the spike needed both).
  expect(cfg.projects[wt].trust_level).toBe("trusted");
  const real = realpathSync(wt);
  if (real !== wt) expect(cfg.projects[real].trust_level).toBe("trusted");
  // MCP sidecar entry with the dispatch envelope (same contract as claude's mcp.json).
  const mcp = cfg.mcp_servers.rvmp;
  expect(mcp.command).toBe(process.execPath);
  expect(mcp.args).toHaveLength(1);
  expect(mcp.args[0].endsWith("mcp-entry.ts")).toBe(true);
  expect(existsSync(mcp.args[0])).toBe(true); // the args target must actually exist
  expect(mcp.default_tools_approval_mode).toBe("approve");
  expect(mcp.env).toEqual({
    RVMP_HOOK_PORT: String(HOOK_PORT),
    RVMP_HOOK_TOKEN: HOOK_TOKEN,
    RVMP_CARD_ID: "7",
    RVMP_DISPATCH_ID: "d-123",
  });

  // auth.json: byte-for-byte copy, private mode.
  expect(readFileSync(join(home, "auth.json"), "utf8"))
    .toBe(readFileSync(join(userCodexDir!, "auth.json"), "utf8"));
  expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);

  // hooks.json: valid JSON, exactly the 10 verified events, spike-recorded
  // entry shape (no matcher key), forwarder command with the baked identity.
  const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")).hooks as
    Record<string, Array<Record<string, unknown>>>;
  expect(Object.keys(hooks).sort()).toEqual([
    "PermissionRequest", "PostCompact", "PostToolUse", "PreCompact", "PreToolUse",
    "SessionStart", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit",
  ]);
  const wantCmd =
    `RVMP_SESSION_ID=\${RVMP_SESSION_ID:-'d-123'} '${join(dataDir, "agents", "hook.sh")}' codex`;
  for (const entries of Object.values(hooks)) {
    expect(entries).toEqual([{ hooks: [{ type: "command", command: wantCmd }] }]);
  }
  // The forwarder itself was (re)written for the signal plane:
  expect(statSync(join(dataDir, "agents", "hook.sh")).mode & 0o777).toBe(0o755);
});

test("the user's ~/.codex is NEVER touched: content, mtimes, and file list identical after spawn", async () => {
  const { userCodexDir, adapter } = makeWorld();
  const dir = userCodexDir!;
  const before = Object.fromEntries(
    readdirSync(dir).map((f) => [f, {
      content: readFileSync(join(dir, f), "utf8"),
      mtime: statSync(join(dir, f)).mtimeMs,
    }]),
  );
  await adapter.spawn(ctx({ worktreePath: mkTmp("cg-wt-") }));
  expect(readdirSync(dir).sort()).toEqual(Object.keys(before).sort()); // nothing added/removed
  for (const [f, snap] of Object.entries(before)) {
    expect(readFileSync(join(dir, f), "utf8")).toBe(snap.content);
    expect(statSync(join(dir, f)).mtimeMs).toBe(snap.mtime);
  }
});

test("envelope race regression lock: near-simultaneous spawns each keep their OWN dispatch env + hook identity", async () => {
  // The old SHARED mirror made [mcp_servers.rvmp.env] last-writer-wins —
  // two concurrent codex spawns could hand one sidecar the OTHER dispatch's
  // card+dispatch envelope, and a consistent swap would pass the ownership
  // check and complete the WRONG card. Per-dispatch homes close it: each
  // config.toml is written once, in its own dir, with its own identity.
  const { dataDir, adapter } = makeWorld();
  const wt = mkTmp("cg-wt-");
  const otherCard: Card = { ...cardRow, id: 8, attemptId: 4 };
  const otherAttempt: Attempt = { ...attempt, id: 4, cardId: 8 };
  await Promise.all([
    adapter.spawn(ctx({ worktreePath: wt })),
    adapter.spawn(ctx({
      worktreePath: wt, card: otherCard, attempt: otherAttempt,
      dispatch: { ...dispatch, id: "d-456", attemptId: 4 },
    })),
  ]);
  const cfgOf = (id: string): any =>
    (Bun as any).TOML.parse(readFileSync(join(homeOf(dataDir, id), "config.toml"), "utf8"));
  expect(cfgOf("d-123").mcp_servers.rvmp.env.RVMP_DISPATCH_ID).toBe("d-123");
  expect(cfgOf("d-123").mcp_servers.rvmp.env.RVMP_CARD_ID).toBe("7");
  expect(cfgOf("d-456").mcp_servers.rvmp.env.RVMP_DISPATCH_ID).toBe("d-456");
  expect(cfgOf("d-456").mcp_servers.rvmp.env.RVMP_CARD_ID).toBe("8");
  expect(readFileSync(join(homeOf(dataDir, "d-123"), "hooks.json"), "utf8")).toContain("'d-123'");
  expect(readFileSync(join(homeOf(dataDir, "d-456"), "hooks.json"), "utf8")).toContain("'d-456'");
});

test("sessions symlink: rollouts land in the shared store, visible from every home; GC of a home spares the store", async () => {
  const { dataDir, adapter } = makeWorld();
  const wt = mkTmp("cg-wt-");
  await adapter.spawn(ctx({ worktreePath: wt }));
  const home1 = homeOf(dataDir, "d-123");
  // Codex writes a rollout through home1's sessions path…
  mkdirSync(join(home1, "sessions", "2026", "07", "19"), { recursive: true });
  writeFileSync(join(home1, "sessions", "2026", "07", "19", "rollout-x.jsonl"), "{}\n");
  // …which physically lands in the one shared store:
  const inStore = join(codexSessionsStore(dataDir), "2026", "07", "19", "rollout-x.jsonl");
  expect(existsSync(inStore)).toBe(true);

  // A later dispatch sees the SAME rollout through its own home — the resume
  // path: `codex resume <id>` under home2 finds home1's transcript.
  await adapter.spawn(ctx({ worktreePath: wt, dispatch: { ...dispatch, id: "d-456" } }));
  const home2 = homeOf(dataDir, "d-456");
  expect(existsSync(join(home2, "sessions", "2026", "07", "19", "rollout-x.jsonl"))).toBe(true);

  // Settings GC (sweepSettingsDirs's exact call shape: recursive+force rmSync
  // on the dispatch dir) removes the symLINK, never the store behind it.
  rmSync(home1, { recursive: true, force: true });
  expect(existsSync(home1)).toBe(false);
  expect(existsSync(inStore)).toBe(true);
  expect(existsSync(join(home2, "sessions", "2026", "07", "19", "rollout-x.jsonl"))).toBe(true);
});

test("a user with no ~/.codex at all still gets a working home (managed block only, no auth.json)", async () => {
  const { dataDir, adapter } = makeWorld({ userCodexDir: null });
  const wt = mkTmp("cg-wt-");
  await adapter.spawn(ctx({ worktreePath: wt }));
  const home = homeOf(dataDir, "d-123");
  const cfg = (Bun as any).TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as any;
  expect(cfg.projects[wt].trust_level).toBe("trusted");
  expect(cfg.mcp_servers.rvmp.command).toBe(process.execPath);
  expect(existsSync(join(home, "auth.json"))).toBe(false); // nothing to copy — codex will show login
  expect(existsSync(join(home, "hooks.json"))).toBe(true);
  expect(lstatSync(join(home, "sessions")).isSymbolicLink()).toBe(true);
});

test("mirror SOURCE honors a custom $CODEX_HOME env — unless it lies in our managed tree (realpath self-mirror guard)", async () => {
  const saved = process.env.CODEX_HOME;
  const savedHome = process.env.HOME;
  try {
    // Custom user CODEX_HOME → that's where the real config lives; mirror it.
    const custom = mkTmp("cg-custom-codex-");
    writeFileSync(join(custom, "config.toml"), `model = "from-custom-home"\n`);
    const dataDir = mkTmp("cg-codex-");
    const ptys = new FakePtys();
    process.env.CODEX_HOME = custom;
    const adapter = new CodexAdapter({
      dataDir, hookPort: HOOK_PORT, hookToken: HOOK_TOKEN, ptys, timing: TIMING,
    });
    await adapter.spawn(ctx());
    const home1 = homeOf(dataDir, "d-123");
    expect(readFileSync(join(home1, "config.toml"), "utf8")).toContain(`model = "from-custom-home"`);

    // CODEX_HOME pointing INSIDE our managed tree (a daemon launched from a
    // rvmp codex pane inherits the per-dispatch home) must NOT
    // self-mirror: the source config already carries a managed block, and
    // copying it would stack a second one into invalid TOML. Hermetic ~ for
    // the fallback (os.homedir honors $HOME on POSIX) — the test never reads
    // the real one.
    process.env.CODEX_HOME = home1;
    process.env.HOME = mkTmp("cg-home-");
    const adapter2 = new CodexAdapter({
      dataDir, hookPort: HOOK_PORT, hookToken: HOOK_TOKEN, ptys, timing: TIMING,
      userCodexDir: undefined,
    });
    await adapter2.spawn(ctx({ dispatch: { ...dispatch, id: "d-457" } }));
    const cfg2 = readFileSync(join(homeOf(dataDir, "d-457"), "config.toml"), "utf8");
    // Exactly one managed block — built from a non-managed source (the
    // hermetic empty ~), never from home1; a self-mirror would have stacked
    // home1's block under this one.
    expect(cfg2.split("managed by rvmp").length - 1).toBe(1);
    expect(cfg2).not.toContain(`model = "from-custom-home"`); // custom home no longer the source

    // A SYMLINKED spelling of the same per-dispatch home must not defeat the
    // guard: both sides are realpath'd before the prefix comparison.
    const alias = join(mkTmp("cg-alias-"), "data");
    symlinkSync(dataDir, alias);
    process.env.CODEX_HOME = join(alias, "agents", "d-123");
    const adapter3 = new CodexAdapter({
      dataDir, hookPort: HOOK_PORT, hookToken: HOOK_TOKEN, ptys, timing: TIMING,
    });
    await adapter3.spawn(ctx({ dispatch: { ...dispatch, id: "d-458" } }));
    const cfg3 = readFileSync(join(homeOf(dataDir, "d-458"), "config.toml"), "utf8");
    expect(cfg3.split("managed by rvmp").length - 1).toBe(1);
    expect(cfg3).not.toContain(`model = "from-custom-home"`);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("hook command identity semantics: per-process env wins, baked id is the fallback (POSIX ${:-})", async () => {
  // The home is per-dispatch, so the baked id always matches — the construct
  // stays as belt-and-braces: the spawn-time PTY env id resolves first, the
  // baked id covers a CLI that scrubs its hook env.
  const probe = `RVMP_SESSION_ID=\${RVMP_SESSION_ID:-'baked-id'} printenv RVMP_SESSION_ID`;
  const run = async (sid?: string): Promise<string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "RVMP_SESSION_ID") env[k] = v;
    }
    if (sid !== undefined) env.RVMP_SESSION_ID = sid;
    const p = Bun.spawn({ cmd: ["/bin/sh", "-c", probe], env, stdout: "pipe" });
    await p.exited;
    return (await new Response(p.stdout).text()).trim();
  };
  expect(await run("env-id")).toBe("env-id"); // inherited PTY env → its own identity
  expect(await run()).toBe("baked-id"); // env scrubbed by the CLI → the baked fallback
});

for (const mode of ["ask", "auto", "host"] as const) {
  test(`mirror config: rvmp MCP tools are server-scoped pre-approved in ${mode} mode`, async () => {
    const { dataDir, adapter } = makeWorld({ userCodexDir: null });
    await adapter.spawn(ctx({ mode }));
    const cfg = (Bun as any).TOML.parse(
      readFileSync(join(homeOf(dataDir, "d-123"), "config.toml"), "utf8"),
    ) as any;
    expect(cfg.mcp_servers.rvmp.default_tools_approval_mode).toBe("approve");
    expect(cfg.approval_policy).toBeUndefined();
  });
}

// ---------------------------------------------------------------------------
// Argv per mode / resume (recorded working invocations, c1–c3 + verified
// 0.144.6 flag surface) + spawn env
// ---------------------------------------------------------------------------

test("spawn argv: ask mode = bare trust-bypassed TUI (codex's own prompting)", async () => {
  const { ptys, adapter } = makeWorld({ userCodexDir: null });
  await adapter.spawn(ctx({ mode: "ask" }));
  expect(ptys.opened[0]!.cmd).toEqual(["codex", "--dangerously-bypass-hook-trust"]);
});

test("spawn argv: auto mode = native sandbox via -c sandbox_mode=workspace-write (spec §6)", async () => {
  const { ptys, adapter } = makeWorld({ userCodexDir: null });
  await adapter.spawn(ctx({ mode: "auto" }));
  expect(ptys.opened[0]!.cmd).toEqual([
    "codex", "--dangerously-bypass-hook-trust", "-c", `sandbox_mode="workspace-write"`,
  ]);
});

test("spawn argv: host mode = --dangerously-bypass-approvals-and-sandbox (YOLO)", async () => {
  const { ptys, adapter } = makeWorld({ userCodexDir: null });
  await adapter.spawn(ctx({ mode: "host" }));
  expect(ptys.opened[0]!.cmd).toEqual([
    "codex", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox",
  ]);
});

test("spawn argv: resume is the `resume <id>` SUBCOMMAND, after re-passed mode flags (c2 order)", async () => {
  const { ptys, adapter } = makeWorld({ userCodexDir: null });
  await adapter.spawn(ctx({ mode: "auto", resumeSessionId: SPIKE_SID }));
  expect(ptys.opened[0]!.cmd).toEqual([
    "codex", "--dangerously-bypass-hook-trust", "-c", `sandbox_mode="workspace-write"`,
    "resume", SPIKE_SID,
  ]);
});

test("spawn argv: no resume subcommand without a resumeSessionId (null included)", async () => {
  const { ptys, adapter } = makeWorld({ userCodexDir: null });
  await adapter.spawn(ctx({ resumeSessionId: null }));
  expect(ptys.opened[0]!.cmd).not.toContain("resume");
});

test("spawn opens an agent-kind PTY in the worktree: CODEX_HOME→per-dispatch home, scrubbed env + RVMP_*", async () => {
  process.env.CLAUDE_PROBE = "leak"; // daemon itself running inside a CC session
  try {
    const { dataDir, ptys, adapter } = makeWorld({ userCodexDir: null });
    const res = await adapter.spawn(ctx());
    const o = ptys.opened[0]!;
    expect(o.kind).toBe("agent");
    expect(o.cwd).toBe("/tmp/wt");
    expect(o.projectId).toBe("p1");
    expect(o.worktreeId).toBe("wt1");
    expect(o.attemptId).toBe(3);
    expect(o.title).toBe("Fix the login bug");
    const env = o.env!;
    expect(env.CODEX_HOME).toBe(homeOf(dataDir, "d-123")); // the isolation seam itself
    expect(env.RVMP_SESSION_ID).toBe("d-123");
    expect(env.RVMP_HOOK_PORT).toBe(String(HOOK_PORT));
    expect(env.RVMP_HOOK_TOKEN).toBe(HOOK_TOKEN);
    expect(env.TERM).toBe("xterm-256color");
    expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE"))).toEqual([]);
    expect(res.sessionMeta).toEqual(ptys.metas[0]!);
  } finally {
    delete process.env.CLAUDE_PROBE;
  }
});

test("spawn injects the prompt \\x15-first, then a separate \\r submit (shared Orca paste rule)", async () => {
  const { ptys, adapter } = makeWorld({ userCodexDir: null });
  await adapter.spawn(ctx());
  expect(ptys.writes).toHaveLength(2);
  const [paste, enter] = ptys.writes;
  expect(paste!.startsWith("\x15")).toBe(true);
  expect(paste!).toContain("Fix the login bug");
  expect(paste!).toContain("dispatch d-123");
  expect(paste!).toContain("task_complete");
  expect(paste!).not.toContain("\r");
  expect(enter).toBe("\r");
});

test("adapter identity and onHook delegation", () => {
  const { adapter } = makeWorld({ userCodexDir: null });
  expect(adapter.agent).toBe("codex");
  expect(normalizeCodexHook(fx("stop.json"))).toEqual([{ s: "complete-eval" }]);
});
