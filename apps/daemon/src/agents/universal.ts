import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@codegent/protocol";
import { Classifier, STARTUP_GRACE_MS, type DetectState } from "../detect/classifier";
import { GhosttyScreenGrid } from "../detect/spike-grid";
import {
  AGENT_POLL_IDENTIFIED_MS,
  AGENT_POLL_UNIDENTIFIED_MS,
  capturePsSnapshot,
} from "../detect/process-tree";
import { recordProcessGroup } from "../pty/reap";
import { scrubAgentEnv } from "../pty/session";
import {
  DEFAULT_INJECT_TIMING,
  buildTaskPrompt,
  injectTaskPrompt,
  shq,
  writePrivate,
  type InjectTiming,
} from "./common";
import type {
  AdapterPtys,
  AdapterSignal,
  AgentAdapter,
  SpawnCtx,
  SpawnResult,
} from "./types";

export const UNIVERSAL_AGENT_NAMES = [
  "gemini",
  "opencode",
  "aider",
  "amp",
  "goose",
  "generic",
] as const satisfies readonly Card["agent"][];

export type UniversalAgent = (typeof UNIVERSAL_AGENT_NAMES)[number];

const UNIVERSAL_AGENTS = new Set<string>(UNIVERSAL_AGENT_NAMES);
const MCP_CAPABLE_AGENTS = new Set<UniversalAgent>([
  "gemini",
  "opencode",
  "amp",
  "goose",
]);

export interface UniversalNormalizeContext {
  /** True only after the engine has accepted session-started for this dispatch. */
  assigned: boolean;
  /** A successful MCP completion makes idle irrelevant; it never creates a signal. */
  taskCompleteReceived: boolean;
}

/**
 * Pure content-free bridge from Task 6 into the v0.2 signal contract.
 *
 * There is intentionally no completion branch: I1 permits only the MCP
 * `task_complete` transport to drive review. `gone` is also absent because
 * the PTY exit observer already owns the engine's crash/interrupted path.
 */
export function normalizeUniversalState(
  detected: DetectState,
  context: UniversalNormalizeContext,
): AdapterSignal[] {
  switch (detected.state) {
    case "blocked":
      return context.assigned ? [{ s: "flag", kind: "question" }] : [];
    case "idle":
      return context.assigned && !context.taskCompleteReceived
        ? [{ s: "flag", kind: "silent" }]
        : [];
    case "working":
      return context.assigned ? [{ s: "flag-clear" }] : [];
    case "gone":
    case "unknown":
      return [];
  }
}

interface UniversalGrid {
  screenGrid(bytes: Uint8Array): ReturnType<GhosttyScreenGrid["screenGrid"]>;
  dispose(): void;
}

export interface UniversalAdapterDeps {
  dataDir: string;
  hookPort: number;
  hookToken: string;
  ptys: AdapterPtys;
  timing?: Partial<InjectTiming>;
  /** Test seams; production uses the Task-1 grid and Task-2 ps capture. */
  clock?: () => number;
  createGrid?: () => Promise<UniversalGrid>;
  captureProcesses?: typeof capturePsSnapshot;
}

interface Sidecar {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface Launch {
  cmd: string[];
  env: Record<string, string>;
}

function sidecar(ctx: SpawnCtx, deps: UniversalAdapterDeps): Sidecar {
  return {
    command: "bun",
    args: [join(import.meta.dir, "mcp-entry.ts")],
    env: {
      CODEGENT_HOOK_PORT: String(deps.hookPort),
      CODEGENT_HOOK_TOKEN: deps.hookToken,
      CODEGENT_CARD_ID: String(ctx.card.id),
      CODEGENT_DISPATCH_ID: ctx.dispatch.id,
    },
  };
}

/** Materialize only external config; the managed worktree remains untouched. */
function launchFor(
  agent: UniversalAgent,
  dir: string,
  ctx: SpawnCtx,
  deps: UniversalAdapterDeps,
): Launch {
  const mcp = sidecar(ctx, deps);
  const env: Record<string, string> = {
    ...scrubAgentEnv(process.env),
    CODEGENT_AGENT: agent,
    CODEGENT_HOOK_PORT: String(deps.hookPort),
    CODEGENT_HOOK_TOKEN: deps.hookToken,
    CODEGENT_CARD_ID: String(ctx.card.id),
    CODEGENT_DISPATCH_ID: ctx.dispatch.id,
    CODEGENT_SESSION_ID: ctx.dispatch.id,
  };

  switch (agent) {
    case "gemini": { // official settings.json `mcpServers`; system path keeps the repo clean
      const path = join(dir, "gemini-settings.json");
      writePrivate(
        path,
        JSON.stringify({ mcpServers: { codegent: { ...mcp, trust: true } } }, null, 2),
      );
      return { cmd: ["gemini"], env: { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: path } };
    }
    case "opencode": { // official OPENCODE_CONFIG + local MCP shape
      const path = join(dir, "opencode.json");
      writePrivate(
        path,
        JSON.stringify(
          {
            mcp: {
              codegent: {
                type: "local",
                command: [mcp.command, ...mcp.args],
                enabled: true,
                environment: mcp.env,
              },
            },
          },
          null,
          2,
        ),
      );
      return { cmd: ["opencode"], env: { ...env, OPENCODE_CONFIG: path } };
    }
    case "amp": // CLI overlay has highest precedence and needs no trust prompt
      return {
        cmd: ["amp", "--mcp-config", JSON.stringify({ codegent: mcp })],
        env,
      };
    case "goose": // Goose accepts a one-session stdio extension command
      return {
        cmd: ["goose", "session", "--with-extension", `bun ${shq(mcp.args[0]!)}`],
        env,
      };
    case "aider":
    case "generic":
      // These labels have no stable native MCP-config surface. They still get
      // process/OSC/screen orchestration; idle degrades visibly to `silent`.
      return { cmd: [agent], env };
  }
}

export class UniversalAdapter implements AgentAdapter {
  readonly agent = "universal" as const;
  private readonly timing: InjectTiming;
  private readonly clock: () => number;
  private readonly createGrid: () => Promise<UniversalGrid>;
  private readonly captureProcesses: typeof capturePsSnapshot;
  private readonly cleanupByDispatch = new Map<string, () => void>();

  constructor(private readonly deps: UniversalAdapterDeps) {
    this.timing = { ...DEFAULT_INJECT_TIMING, ...deps.timing };
    this.clock = deps.clock ?? Date.now;
    this.createGrid = deps.createGrid ?? (() => GhosttyScreenGrid.create({ cols: 120, rows: 32 }));
    this.captureProcesses = deps.captureProcesses ?? capturePsSnapshot;
  }

  async spawn(ctx: SpawnCtx): Promise<SpawnResult> {
    const label = ctx.card.agent;
    if (!UNIVERSAL_AGENTS.has(label)) {
      throw new Error(`UniversalAdapter cannot spawn agent '${label}'`);
    }
    const agent = label as UniversalAgent;
    const dir = join(this.deps.dataDir, "agents", ctx.dispatch.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const launch = launchFor(agent, dir, ctx, this.deps);
    const grid = await this.createGrid();
    const classifier = new Classifier({
      agentHint: agent,
      clock: this.clock,
      screenGrid: (bytes) => grid.screenGrid(bytes),
    });
    const idleEligibleAt = this.clock() + STARTUP_GRACE_MS;

    let meta;
    try {
      meta = this.deps.ptys.open({
        projectId: ctx.project.id,
        cwd: ctx.worktreePath,
        title: ctx.card.title,
        worktreeId: ctx.attempt.worktreeId,
        kind: "agent",
        cmd: launch.cmd,
        env: launch.env,
        attemptId: ctx.attempt.id,
      });
    } catch (error) {
      grid.dispose();
      throw error;
    }

    const sess = this.deps.ptys.get(meta.id);
    if (!sess) {
      grid.dispose();
      throw new Error(`universal PTY '${meta.id}' disappeared during spawn`);
    }
    recordProcessGroup(dir, sess.pid, ctx.dispatch.id);

    let active = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let lastPublished: DetectState | null = null;
    let identified = true;
    let stopDetection = (): void => {};

    const publish = (detected: DetectState): void => {
      identified = detected.agent !== null;
      if (!active || detected === lastPublished) return;
      // Classifier startup grace deliberately reports an idle baseline while
      // the freshly submitted prompt is still reaching the agent. Do not turn
      // that protective baseline into a false silent flag; the first sample at
      // or after the grace boundary remains publishable even if object identity
      // did not change.
      if (detected.state === "idle" && this.clock() < idleEligibleAt) return;
      lastPublished = detected;
      if (detected.state === "gone") {
        ctx.reportProcessGone?.();
        stopDetection();
        return;
      }
      for (const signal of normalizeUniversalState(detected, {
        assigned: true,
        // The engine's running-dispatch latch drops every signal after an
        // accepted task_complete, so an active adapter cannot observe true.
        taskCompleteReceived: false,
      })) {
        ctx.emitSignal?.(signal);
      }
    };

    const sample = (): void => {
      try {
        publish(classifier.sample(this.clock()));
      } catch {
        // Detection is fail-open; the PTY and task remain usable.
      }
    };

    const offData = sess.onData((bytes) => {
      try {
        classifier.feed(bytes);
        sample();
      } catch {
        // A malformed terminal stream cannot tear down the PTY fanout.
      }
    });

    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      offData();
      grid.dispose();
      if (this.cleanupByDispatch.get(ctx.dispatch.id) === cleanup) {
        this.cleanupByDispatch.delete(ctx.dispatch.id);
      }
    };
    stopDetection = cleanup;
    this.cleanupByDispatch.get(ctx.dispatch.id)?.();
    this.cleanupByDispatch.set(ctx.dispatch.id, cleanup);
    void sess.exited?.finally(cleanup).catch(() => {});

    const schedulePoll = (): void => {
      if (stopped) return;
      timer = setTimeout(
        () => void poll(),
        identified ? AGENT_POLL_IDENTIFIED_MS : AGENT_POLL_UNIDENTIFIED_MS,
      );
      (timer as unknown as { unref?: () => void }).unref?.();
    };
    const poll = async (): Promise<void> => {
      if (stopped || polling) return;
      polling = true;
      try {
        classifier.observe(sess.pid, await this.captureProcesses(sess.pid));
        sample();
      } catch {
        // ps races/failures are non-authoritative; the next cadence retries.
      } finally {
        polling = false;
        schedulePoll();
      }
    };

    try {
      await injectTaskPrompt(
        this.deps.ptys,
        meta.id,
        buildTaskPrompt({
          title: ctx.card.title,
          body: ctx.card.body,
          cardId: ctx.card.id,
          attemptId: ctx.attempt.id,
          dispatchId: ctx.dispatch.id,
          extra: ctx.extraPrompt,
        }),
        this.timing,
      );
      // Universal CLIs have no shared native resume/session-id contract. PTY
      // readiness is the start fact, and null prevents the engine from later
      // mistaking a synthetic id for a resumable native conversation.
      ctx.emitSignal?.({ s: "session-started", adapterSessionId: null });
      active = true;
      sample();
      schedulePoll();
      return { sessionMeta: meta, settingsDir: dir };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  onHook(_sessionId: string, _event: unknown): AdapterSignal[] {
    return [];
  }
}

export function universalAgentSupportsMcp(agent: UniversalAgent): boolean {
  return MCP_CAPABLE_AGENTS.has(agent);
}
