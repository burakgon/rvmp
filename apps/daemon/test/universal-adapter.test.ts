import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTUP_GRACE_MS, type DetectState } from "../src/detect/classifier";
import { transition } from "../src/orchestrator/machine";
import { UniversalAdapter, normalizeUniversalState } from "../src/agents/universal";
import type { AdapterSignal } from "../src/agents/types";
import type { Card, SessionMeta } from "@codegent/protocol";
import type { OpenSessionOpts } from "../src/pty/manager";

const detected = (state: DetectState["state"]): DetectState => ({
  agent: "gemini",
  state,
  since: 1_000,
});

const assigned = { assigned: true, taskCompleteReceived: false } as const;

const cleanups: string[] = [];
afterAll(() => {
  for (const path of cleanups) rmSync(path, { recursive: true, force: true });
});

test("universal normalizer maps content-free DetectState into attention signals", () => {
  expect(normalizeUniversalState(detected("blocked"), assigned)).toEqual([
    { s: "flag", kind: "question" },
  ]);
  expect(normalizeUniversalState(detected("idle"), assigned)).toEqual([
    { s: "flag", kind: "silent" },
  ]);
  expect(normalizeUniversalState(detected("working"), assigned)).toEqual([
    { s: "flag-clear" },
  ]);
  expect(normalizeUniversalState(detected("gone"), assigned)).toEqual([]);
  expect(normalizeUniversalState(detected("unknown"), assigned)).toEqual([
    { s: "flag", kind: "silent" },
  ]);
});

test("A3: assigned unknown degrades to silent attention while unassigned unknown emits nothing", () => {
  expect(normalizeUniversalState(detected("unknown"), assigned)).toEqual([
    { s: "flag", kind: "silent" },
  ]);
  expect(normalizeUniversalState(detected("unknown"), {
    assigned: false,
    taskCompleteReceived: false,
  })).toEqual([]);
});

test("universal normalizer never emits completion and ignores unassigned/completed idle", () => {
  const states: DetectState["state"][] = [
    "blocked",
    "idle",
    "working",
    "gone",
    "unknown",
  ];
  for (const state of states) {
    expect(
      normalizeUniversalState(detected(state), assigned).some(
        (signal) => signal.s === "complete-eval",
      ),
    ).toBe(false);
  }
  expect(
    normalizeUniversalState(detected("idle"), {
      assigned: false,
      taskCompleteReceived: false,
    }),
  ).toEqual([]);
  expect(
    normalizeUniversalState(detected("idle"), {
      assigned: true,
      taskCompleteReceived: true,
    }),
  ).toEqual([]);
});

test("universal silent attention never produces a push effect", () => {
  const card: Card = {
    id: 1,
    projectId: "p",
    title: "t",
    body: "",
    phase: "working",
    agent: "gemini",
    worktreeId: "w",
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    workingSub: "running",
    errorKind: null,
    reviewSub: null,
    inputKind: null,
    inputSince: null,
    round: 1,
    auto: true,
    attemptId: 1,
    readySince: null, mergeSha: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    ciStatus: null,
  };
  const [signal] = normalizeUniversalState(detected("idle"), assigned);
  if (!signal || signal.s !== "flag") throw new Error("expected idle attention flag");

  expect(transition(card, { t: "flag", kind: signal.kind }, 2_000).effects).toEqual([]);
});

test("A4: startup grace begins after task submission even when readiness consumed the spawn-time window", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-universal-grace-"));
  cleanups.push(dataDir);
  let now = 0;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const callbacks = new Set<(bytes: Uint8Array) => void>();
  const session = {
    pid: 0,
    exited,
    write(data: Uint8Array | string) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (text !== "\r") now = STARTUP_GRACE_MS + 250;
    },
    onData(cb: (bytes: Uint8Array) => void) {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
  };
  const meta: SessionMeta = {
    id: "u-grace",
    projectId: "p",
    kind: "agent",
    title: "Grace task",
    cwd: "/worktree",
    worktreeId: "w",
    live: true,
    createdAt: 1,
    adapterSessionId: null,
    attemptId: 2,
  };
  const signals: AdapterSignal[] = [];
  const adapter = new UniversalAdapter({
    dataDir,
    hookPort: 4667,
    hookToken: "hook-token",
    ptys: {
      open: () => meta,
      get: (id) => id === meta.id ? session : undefined,
    },
    timing: { capMs: 0, minReadyMs: 0, quietMs: 0, enterDelayMs: 0 },
    clock: () => now,
    createGrid: async () => ({
      screenGrid: () => ({ rows: [], oscTitle: null, oscProgress: null }),
      dispose: () => {},
    }),
    captureProcesses: async () => [],
  });

  await adapter.spawn({
    project: { id: "p", name: "P", path: "/repo", baseBranch: "main", createdAt: 1, workerLimit: 1 },
    card: { ...cardForSpawn, title: "Grace task", agent: "gemini" },
    attempt: { id: 2, cardId: 1, worktreeId: "w", seq: 1, status: "running", beforeHead: "abc", createdAt: 1 },
    dispatch: { id: "dispatch-grace", attemptId: 2, status: "running", lastProgressAt: null, createdAt: 1 },
    worktreePath: "/worktree",
    mode: "auto",
    emitSignal: (signal) => signals.push(signal),
  });

  // The old spawn anchor is already expired, but submission just happened.
  expect(signals).toEqual([{ s: "session-started", adapterSessionId: null }]);
  now += STARTUP_GRACE_MS + 1;
  for (const callback of callbacks) callback(new Uint8Array());
  expect(signals.at(-1)).toEqual({ s: "flag", kind: "silent" });

  resolveExit(0);
  await exited;
});

test("UniversalAdapter spawns a bare Gemini PTY with isolated MCP config", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-universal-"));
  cleanups.push(dataDir);
  let opened: OpenSessionOpts | null = null;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const writes: string[] = [];
  const callbacks = new Set<(bytes: Uint8Array) => void>();
  const session = {
    pid: 0,
    exited,
    write(data: Uint8Array | string) {
      writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    onData(cb: (bytes: Uint8Array) => void) {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
  };
  const meta: SessionMeta = {
    id: "u-pty",
    projectId: "p",
    kind: "agent",
    title: "Gemini task",
    cwd: "/worktree",
    worktreeId: "w",
    live: true,
    createdAt: 1,
    adapterSessionId: null,
    attemptId: 2,
  };
  const ptys = {
    open(opts: OpenSessionOpts) {
      opened = opts;
      return meta;
    },
    get(id: string) {
      return id === meta.id ? session : undefined;
    },
  };
  let disposed = false;
  const signals: unknown[] = [];
  const adapter = new UniversalAdapter({
    dataDir,
    hookPort: 4667,
    hookToken: "hook-token",
    ptys,
    timing: { capMs: 0, minReadyMs: 0, quietMs: 0, enterDelayMs: 0 },
    clock: () => 10_000,
    createGrid: async () => ({
      screenGrid: () => ({ rows: [], oscTitle: null, oscProgress: null }),
      dispose: () => {
        disposed = true;
      },
    }),
    captureProcesses: async () => [],
  });

  const result = await adapter.spawn({
    project: { id: "p", name: "P", path: "/repo", baseBranch: "main", createdAt: 1, workerLimit: 1 },
    card: { ...cardForSpawn, agent: "gemini" },
    attempt: { id: 2, cardId: 1, worktreeId: "w", seq: 1, status: "running", beforeHead: "abc", createdAt: 1 },
    dispatch: { id: "dispatch-1", attemptId: 2, status: "running", lastProgressAt: null, createdAt: 1 },
    worktreePath: "/worktree",
    mode: "auto",
    emitSignal: (signal) => signals.push(signal),
  });

  expect(result.sessionMeta).toEqual(meta);
  expect(result.settingsDir).toBe(join(dataDir, "agents", "dispatch-1"));
  expect(result.latestDetectState?.()).toEqual({ state: "idle", since: 10_000 });
  expect(Object.keys(result.latestDetectState?.() ?? {}).sort()).toEqual(["since", "state"]);
  expect(opened).not.toBeNull();
  expect(opened!.cmd).toEqual(["gemini"]);
  expect(opened!.env?.CODEGENT_AGENT).toBe("gemini");
  expect(signals).toEqual([{ s: "session-started", adapterSessionId: null }]);
  expect(writes.at(-1)).toBe("\r");

  const settingsPath = opened!.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  expect(typeof settingsPath).toBe("string");
  const settings = JSON.parse(readFileSync(settingsPath!, "utf8"));
  expect(settings.mcpServers.codegent).toMatchObject({
    command: "bun",
    env: {
      CODEGENT_CARD_ID: "1",
      CODEGENT_DISPATCH_ID: "dispatch-1",
    },
    trust: true,
  });

  resolveExit(0);
  await exited;
  await Promise.resolve();
  expect(disposed).toBe(true);
  expect(result.latestDetectState?.()).toBeNull();
});

const cardForSpawn: Card = {
  id: 1,
  projectId: "p",
  title: "Gemini task",
  body: "do it",
  phase: "working",
  agent: "gemini",
  worktreeId: "w",
  position: 1,
  createdAt: 1,
  updatedAt: 1,
  workingSub: "starting",
  errorKind: null,
  reviewSub: null,
  inputKind: null,
  inputSince: null,
  round: 1,
  auto: true,
  attemptId: 2,
  readySince: null, mergeSha: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  ciStatus: null,
};
