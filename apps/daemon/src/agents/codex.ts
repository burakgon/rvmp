import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { scrubAgentEnv } from "../pty/session";
import { writeHookScript } from "./receiver";
import {
  DEFAULT_INJECT_TIMING, buildTaskPrompt, injectTaskPrompt, shq, writePrivate,
  type InjectTiming,
} from "./common";
import type {
  AdapterPtys, AdapterSignal, AgentAdapter, SpawnCtx, SpawnResult,
} from "./types";

/**
 * Codex adapter — every shape below is the RECORDED WORKING CONFIG from the
 * live spike against codex-cli 0.144.6 (docs/research/cc-codex-hook-contract.md
 * §3/§7 facts, captures in docs/research/tmp/cc-hook-spike/ scenarios c1–c3,
 * canonical trimmed payloads in test/fixtures/codex-hooks/). Where the plan
 * sketch and the contract doc differ, the contract doc wins.
 *
 * Key contract facts driving this file:
 * - Codex ships 10 Claude-compatible hook events via `$CODEX_HOME/hooks.json`
 *   (auto-discovered). No StopFailure, no SessionEnd, no Notification.
 * - Hooks are trust-gated: without `--dangerously-bypass-hook-trust` they
 *   silently never fire (claim 7a).
 * - `session_id` is in EVERY payload; TUI session hooks fire LAZILY at the
 *   first prompt submit (claim 7b) — SessionStart still precedes every other
 *   event, it just arrives late in wall-clock.
 * - `codex resume <id>` works and fires SessionStart(source:"resume") with
 *   the same session id (c2), flags placed BEFORE the subcommand as recorded.
 * - PermissionRequest hook OUTPUT can auto-decide — we must never emit a
 *   decision (hook.sh exits 0 with no output) so Codex's own approval UI
 *   still renders (§3 "Codex gaps", Orca does the same).
 */

/** The 10 verified Codex hook events (contract doc claim 7a — the full set;
 * registered exactly like the spike's working codex-hooks.json). */
const CODEX_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PermissionRequest", "Stop", "SubagentStart", "SubagentStop",
  "PreCompact", "PostCompact",
] as const;

/** Reserved dir name under `<dataDir>/agents/` for the DURABLE shared codex
 * store. It holds only `sessions/` — the rollout transcripts `codex resume`
 * needs — written through each per-dispatch home's `sessions` symlink, so
 * every dispatch sees every transcript. Per-dispatch homes are dispatch-keyed
 * and GC'd by `sweepSettingsDirs`; this dir is exempted by name and never
 * swept. */
export const CODEX_HOME_DIRNAME = "codex-home";

/** The one shared rollout store every per-dispatch home symlinks `sessions` to. */
export function codexSessionsStore(dataDir: string): string {
  return join(dataDir, "agents", CODEX_HOME_DIRNAME, "sessions");
}

/** TOML basic strings share JSON's escape grammar for everything
 * JSON.stringify emits (\" \\ \n \t \uXXXX …) — so this IS a TOML string. */
const tomlStr = (s: string): string => JSON.stringify(s);

/** realpath when the path exists (a symlinked spelling must not defeat path
 * comparisons — macOS /tmp,/var → /private/…), resolve() otherwise. */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export interface CodexAdapterDeps {
  dataDir: string;
  /** Signal-plane endpoint (T6 receiver) — baked into the mirror's MCP entry. */
  hookPort: number;
  hookToken: string;
  ptys: AdapterPtys;
  timing?: Partial<InjectTiming>;
  /** The USER's codex home to mirror FROM (read-only; never written). Tests
   * point this at a fixture dir; production defaults to `~/.codex`. */
  userCodexDir?: string;
}

/**
 * Pure normalizer: raw Codex hook payload → content-free signals, per the
 * contract doc §3 + the §4.1 truth table. Anything unknown or malformed → []
 * (fail-open; I2: ambiguity degrades to attention elsewhere, never to false
 * progress here).
 *
 * Mapping decisions (doc-driven):
 * - Stop → complete-eval: Codex's ONLY Stop-class event. The engine holds the
 *   truth table: pending task_complete → review, else → question flag. Codex
 *   has NO AskUserQuestion-equivalent tool (claim 7b records Claude-style
 *   tool naming with plain exec tools; no question tool exists in 0.144.6),
 *   so question turns land exactly there — Stop without a completion marker.
 * - PermissionRequest → flag(permission), unconditionally (no AskUserQuestion
 *   reclassification to mirror — see above).
 * - No StopFailure/SessionEnd/Notification EXIST (claim 7a) — an API-error
 *   turn emits nothing and is caught by the §6.1 fallback stack (v0.3) /
 *   crash detection, never here.
 * - PostToolUse → []: symmetric with the CC adapter, which only flag-clears
 *   for AskUserQuestion answers; a granted Bash approval keeps its flag until
 *   the turn ends on both agents.
 */
export function normalizeCodexHook(event: unknown): AdapterSignal[] {
  if (typeof event !== "object" || event === null) return [];
  const e = event as Record<string, unknown>;
  switch (e.hook_event_name) {
    case "SessionStart": // sources startup|resume|clear|compact — all carry session_id
      return typeof e.session_id === "string" && e.session_id
        ? [{ s: "session-started", adapterSessionId: e.session_id }]
        : [];
    case "PermissionRequest":
      return [{ s: "flag", kind: "permission" }];
    case "Stop":
      return [{ s: "complete-eval" }];
    default:
      return [];
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly agent = "codex" as const;
  private timing: InjectTiming;
  /** Spawn keys whose session identity has been captured — the lazy-start
   * guard (claim 7b): if the SessionStart delivery is ever lost on the
   * fail-open transport, the FIRST event seen for a key synthesizes
   * session-started from its `session_id` (present in every payload), so the
   * card never wedges in `starting`. In-memory only, one small entry per
   * spawn; signals stay content-free. */
  private seen = new Set<string>();

  constructor(private deps: CodexAdapterDeps) {
    this.timing = { ...DEFAULT_INJECT_TIMING, ...deps.timing };
  }

  private userCodexDir(): string {
    if (this.deps.userCodexDir) return this.deps.userCodexDir;
    // A custom $CODEX_HOME is where the user's real config/credentials live —
    // mirror from THERE. But never from our own managed tree: a daemon
    // launched from inside a codegent agent pane inherits
    // CODEX_HOME=<per-dispatch home>, and self-mirroring would stack managed
    // blocks into invalid TOML. The whole `<dataDir>/agents/` tree is ours
    // (per-dispatch homes + the shared store), and BOTH sides are realpath'd
    // so a symlinked spelling of dataDir can't defeat the guard.
    const envHome = process.env.CODEX_HOME;
    if (envHome) {
      const agents = real(join(this.deps.dataDir, "agents")) + sep;
      if (!(real(envHome) + sep).startsWith(agents)) return envHome;
    }
    return join(homedir(), ".codex");
  }

  /**
   * Build the managed PER-DISPATCH CODEX_HOME (Orca's isolation trick, spec
   * §6), regenerated at EACH spawn so user config drift propagates. The
   * user's `~/.codex` is only ever READ. One home per DISPATCH — claude's
   * per-dispatch dir shape — so config.toml carries exactly THIS dispatch's
   * MCP envelope: near-simultaneous codex spawns can never hand a sidecar
   * another dispatch's identity (the old shared mirror's last-writer-wins
   * envelope race). Layout under `<dataDir>/agents/<dispatchId>/`:
   *   config.toml — user's config.toml copy (if present) + the managed block:
   *                 project trust for the worktree (so the trust onboarding
   *                 menu never swallows the injected prompt) and the codegent
   *                 MCP sidecar entry with this dispatch's envelope.
   *   auth.json   — copy of the user's credentials (the spike's recorded
   *                 runtime requirement — codex under an isolated home has no
   *                 login without it). Codex refreshes tokens against the
   *                 MIRROR copy only.
   *   hooks.json  — the 10 events → hook.sh forwarder with this dispatch's
   *                 identity baked in.
   *   sessions    — SYMLINK to the shared rollout store
   *                 `<dataDir>/agents/codex-home/sessions/`: every dispatch
   *                 sees every transcript, so `codex resume` keeps working
   *                 from any later dispatch. The dir itself is dispatch-keyed,
   *                 so `sweepSettingsDirs` GCs it once the dispatch is
   *                 terminal — rmSync removes the symLINK, never the store.
   */
  private refreshMirror(ctx: SpawnCtx, hookScript: string): string {
    const home = join(this.deps.dataDir, "agents", ctx.dispatch.id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Durable rollouts are SHARED across dispatches via the sessions symlink;
    // the store must exist before codex first writes through the link.
    const store = codexSessionsStore(this.deps.dataDir);
    mkdirSync(store, { recursive: true, mode: 0o700 });
    try {
      symlinkSync(store, join(home, "sessions"));
    } catch (e) {
      // Re-spawn into the same dispatch dir → the link already exists.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const userDir = this.userCodexDir();

    // --- config.toml: user copy + managed block -----------------------------
    const userCfg = join(userDir, "config.toml");
    const base = existsSync(userCfg) ? readFileSync(userCfg, "utf8").replace(/\s*$/, "") : "";
    // Trust both the literal worktree path and its realpath — macOS /tmp and
    // /var are symlinks into /private, and the spike's recorded working config
    // needed both spellings (§5).
    const trustPaths = new Set([ctx.worktreePath]);
    try {
      trustPaths.add(realpathSync(ctx.worktreePath));
    } catch {} // path not on disk yet — the literal entry stands alone
    const managed = [
      "# --- managed by codegent (regenerated at each spawn; edits are overwritten) ---",
      ...[...trustPaths].flatMap((p) => [`[projects.${tomlStr(p)}]`, `trust_level = "trusted"`, ""]),
      "[mcp_servers.codegent]",
      `command = "bun"`,
      `args = [${tomlStr(join(import.meta.dir, "mcp-entry.ts"))}]`,
      "",
      "[mcp_servers.codegent.env]",
      `CODEGENT_HOOK_PORT = ${tomlStr(String(this.deps.hookPort))}`,
      `CODEGENT_HOOK_TOKEN = ${tomlStr(this.deps.hookToken)}`,
      `CODEGENT_CARD_ID = ${tomlStr(String(ctx.card.id))}`,
      `CODEGENT_DISPATCH_ID = ${tomlStr(ctx.dispatch.id)}`,
    ].join("\n");
    writePrivate(join(home, "config.toml"), (base ? base + "\n\n" : "") + managed + "\n");

    // --- auth.json: credentials copy (mirror-only refresh target) -----------
    const userAuth = join(userDir, "auth.json");
    if (existsSync(userAuth)) writePrivate(join(home, "auth.json"), readFileSync(userAuth, "utf8"));

    // --- hooks.json: the 10-event registration (spike-recorded shape) -------
    // Identity: baked dispatch id with an env-preferring guard. The home is
    // per-dispatch, so the baked id always belongs to THIS dispatch; the
    // `${CODEGENT_SESSION_ID:-<baked>}` wrapper stays as belt-and-braces —
    // each codex process resolves its OWN spawn-time env id first (hook
    // commands run via `$SHELL -lc` and inherit the PTY env), falling back to
    // the baked id if codex ever scrubbed its hook env. POSIX assignment
    // context: the expansion never field-splits.
    const command =
      `CODEGENT_SESSION_ID=\${CODEGENT_SESSION_ID:-${shq(ctx.dispatch.id)}} ${shq(hookScript)} codex`;
    const entry = [{ hooks: [{ type: "command", command }] }];
    writePrivate(
      join(home, "hooks.json"),
      JSON.stringify(
        { hooks: Object.fromEntries(CODEX_HOOK_EVENTS.map((ev) => [ev, entry])) },
        null,
        2,
      ),
    );
    return home;
  }

  async spawn(ctx: SpawnCtx): Promise<SpawnResult> {
    const { dataDir, hookPort, hookToken, ptys } = this.deps;
    // T6's fail-open forwarder — idempotent rewrite, returns the canonical path.
    const hookScript = writeHookScript(dataDir);
    const home = this.refreshMirror(ctx, hookScript);

    // Recorded working invocations (harness c1–c3; the doc wins):
    // - `--dangerously-bypass-hook-trust` ALWAYS — without it hooks silently
    //   never fire (claim 7a).
    // - host = YOLO: `--dangerously-bypass-approvals-and-sandbox` (the
    //   binary's only bypass-approvals flag, verified on 0.144.6).
    // - auto = Codex's native sandbox, autonomous (spec §6 "workspace-write"),
    //   via the `-c` config-override mechanism the spike recorded working.
    // - ask = stock prompting (defaults; PermissionRequest → permission flag).
    // - resume: flags BEFORE the subcommand, exactly as recorded in c2.
    //   Re-spawns re-pass the SAME mode flags (spec §4.3).
    const cmd = [
      "codex",
      "--dangerously-bypass-hook-trust",
      ...(ctx.mode === "host"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ctx.mode === "auto"
          ? ["-c", `sandbox_mode="workspace-write"`]
          : []),
      ...(ctx.resumeSessionId ? ["resume", ctx.resumeSessionId] : []),
    ];

    // scrubAgentEnv drops CLAUDE* and pins TERM (shared spawn hygiene);
    // CODEX_HOME points codex at this dispatch's home; CODEGENT_* rides on
    // top for the hook script's env identity (primary under the
    // env-preferring bake).
    const meta = ptys.open({
      projectId: ctx.project.id,
      cwd: ctx.worktreePath,
      title: ctx.card.title,
      worktreeId: ctx.attempt.worktreeId,
      kind: "agent",
      cmd,
      env: {
        ...scrubAgentEnv(process.env),
        CODEX_HOME: home,
        CODEGENT_HOOK_PORT: String(hookPort),
        CODEGENT_HOOK_TOKEN: hookToken,
        CODEGENT_SESSION_ID: ctx.dispatch.id,
      },
      attemptId: ctx.attempt.id,
    });

    await injectTaskPrompt(
      ptys,
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

    // The per-dispatch home is this spawn's settings dir — dispatch-keyed, so
    // `sweepSettingsDirs` GCs it once the dispatch is terminal. Durable
    // rollouts live behind the sessions symlink in the shared store, which
    // the GC exempts by name (CODEX_HOME_DIRNAME).
    return { sessionMeta: meta, settingsDir: home };
  }

  onHook(sessionId: string, event: unknown): AdapterSignal[] {
    const sigs = normalizeCodexHook(event);
    if (!this.seen.has(sessionId)) {
      const sid =
        typeof event === "object" && event !== null &&
        typeof (event as Record<string, unknown>).session_id === "string"
          ? ((event as Record<string, unknown>).session_id as string)
          : "";
      if (sid) {
        this.seen.add(sessionId);
        // Lost-SessionStart guard: the first event for a spawn key doubles as
        // session-started unless it already is one (claim 7b: session_id is
        // in every payload, SessionStart is merely LATE, not guaranteed).
        if (!sigs.some((s) => s.s === "session-started")) {
          return [{ s: "session-started", adapterSessionId: sid }, ...sigs];
        }
      }
    }
    return sigs;
  }
}
