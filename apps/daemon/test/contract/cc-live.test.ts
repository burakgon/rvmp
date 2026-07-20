import { afterAll, describe, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubAgentEnv } from "../../src/pty/session";

const LIVE = process.env.CODEGENT_CONTRACT_LIVE === "1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DUMMY_API_KEY = "codegent-contract-presence-probe";
const AUTH_PROBE_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 120_000;

type HookEvent = Record<string, unknown> & { hook_event_name: string };
type ExpectedEvent = { name: string; requiredKeys: readonly string[] };
type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
type ClaudePreflight =
  | { kind: "ready"; binary: string }
  | { kind: "disabled"; binary: null }
  | { kind: "logged-out"; binary: string; reason: string }
  | { kind: "failure"; binary: string | null; reason: string };
type Harness = {
  root: string;
  project: string;
  logPath: string;
  toolLogPath: string;
  settingsPath: string;
};

const SESSION_START_KEYS = [
  // `model` is present in the recorded interactive startup fixture but omitted
  // by 2.1.215 in `-p`; the adapter contract only requires the stable fields.
  "cwd", "hook_event_name", "session_id", "source", "transcript_path",
] as const;
const RESUME_SESSION_START_KEYS = [
  "cwd", "hook_event_name", "session_id", "source", "transcript_path",
] as const;
const STOP_KEYS = [
  "background_tasks", "cwd", "hook_event_name", "last_assistant_message",
  "permission_mode", "prompt_id", "session_crons", "session_id",
  "stop_hook_active", "transcript_path",
] as const;
const STOP_FAILURE_KEYS = [
  "cwd", "error", "hook_event_name", "last_assistant_message", "prompt_id",
  "session_id", "transcript_path",
] as const;
const PRE_TOOL_USE_KEYS = [
  "cwd", "hook_event_name", "permission_mode", "prompt_id", "session_id",
  "tool_input", "tool_name", "tool_use_id", "transcript_path",
] as const;
const POST_TOOL_USE_KEYS = [
  "cwd", "duration_ms", "hook_event_name", "permission_mode", "prompt_id",
  "session_id", "tool_input", "tool_name", "tool_response", "tool_use_id",
  "transcript_path",
] as const;

const SUCCESS_CONTRACT: readonly ExpectedEvent[] = [
  { name: "SessionStart", requiredKeys: SESSION_START_KEYS },
  { name: "Stop", requiredKeys: STOP_KEYS },
];
const FAILURE_CONTRACT: readonly ExpectedEvent[] = [
  { name: "SessionStart", requiredKeys: SESSION_START_KEYS },
  { name: "StopFailure", requiredKeys: STOP_FAILURE_KEYS },
];
const RESUME_CONTRACT: readonly ExpectedEvent[] = [
  { name: "SessionStart", requiredKeys: RESUME_SESSION_START_KEYS },
  { name: "Stop", requiredKeys: STOP_KEYS },
];
const BASH_TOOL_CONTRACT: readonly ExpectedEvent[] = [
  { name: "PreToolUse", requiredKeys: PRE_TOOL_USE_KEYS },
  { name: "PostToolUse", requiredKeys: POST_TOOL_USE_KEYS },
];

const cleanups: string[] = [];
afterAll(() => {
  for (const path of cleanups) rmSync(path, { recursive: true, force: true });
});
setDefaultTimeout(180_000);

function spawnClaudeAuthProbe(binary: string) {
  return Bun.spawn({
    cmd: [binary, "auth", "status", "--json"],
    env: scrubAgentEnv(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function getClaudePreflight(): Promise<ClaudePreflight> {
  if (!LIVE) return { kind: "disabled", binary: null };

  const binary = Bun.which("claude");
  if (binary === null) {
    return {
      kind: "failure",
      binary: null,
      reason: "CODEGENT_CONTRACT_LIVE=1 but claude was not found on PATH",
    };
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) return { kind: "ready", binary };

  let proc: ReturnType<typeof spawnClaudeAuthProbe>;
  try {
    proc = spawnClaudeAuthProbe(binary);
  } catch (error) {
    return {
      kind: "failure",
      binary,
      reason: `failed to spawn claude auth status --json: ${String(error)}`,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, AUTH_PROBE_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (timedOut) {
      return {
        kind: "failure",
        binary,
        reason: `claude auth status --json timed out after ${AUTH_PROBE_TIMEOUT_MS}ms`,
      };
    }

    let status: { loggedIn?: unknown };
    try {
      status = JSON.parse(stdout) as { loggedIn?: unknown };
    } catch (error) {
      return {
        kind: "failure",
        binary,
        reason: `claude auth status --json returned invalid JSON (exit ${exitCode}): ${String(error)}`,
      };
    }
    if (status.loggedIn === false) {
      return {
        kind: "logged-out",
        binary,
        reason: "claude auth status --json confirmed loggedIn=false",
      };
    }
    if (exitCode !== 0) {
      const stderrTail = stderr.trim().slice(-500) || "(empty)";
      return {
        kind: "failure",
        binary,
        reason: `claude auth status --json exited ${exitCode}; stderr tail: ${stderrTail}`,
      };
    }
    if (status.loggedIn !== true) {
      return {
        kind: "failure",
        binary,
        reason: "claude auth status --json did not return a boolean loggedIn field",
      };
    }
    return { kind: "ready", binary };
  } catch (error) {
    return {
      kind: "failure",
      binary,
      reason: `claude auth status --json probe failed: ${String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const PREFLIGHT = await getClaudePreflight();
const CLAUDE = PREFLIGHT.binary;
const CAN_RUN = PREFLIGHT.kind === "ready";

if (PREFLIGHT.kind === "logged-out") {
  console.log(`[cc-contract] skipped: ${PREFLIGHT.reason}`);
}
if (PREFLIGHT.kind === "failure") {
  test("Claude Code live hook contract preflight", () => {
    throw new Error(`[cc-contract:preflight] ${PREFLIGHT.reason}`);
  });
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createHarness(name: string): Harness {
  // macOS exposes tmpdir() below /var, while the Claude sandbox canonicalizes
  // it to /private/var. Spawn with the canonical spelling or an in-cwd write
  // can be rejected as outside the (textually different) allowed directory.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `codegent-cc-${name}-`)));
  cleanups.push(root);
  const project = join(root, "project");
  mkdirSync(project, { mode: 0o700 });
  const logPath = join(root, "events.jsonl");
  writeFileSync(logPath, "", { mode: 0o600 });
  const toolLogPath = join(root, "tool-events.jsonl");
  writeFileSync(toolLogPath, "", { mode: 0o600 });

  // Hooks receive one JSON object on stdin. Keep the recorder dependency-free
  // so the future Linux contract agent needs only the same git + Bun + claude
  // prerequisites as the ordinary pipeline.
  const makeRecorder = (filename: string, target: string): string => {
    const path = join(root, filename);
    writeFileSync(
      path,
      `#!/bin/sh\npayload=$(cat) || exit 0\nprintf '%s\\n' "$payload" >> ${shq(target)} || true\n`,
      { mode: 0o700 },
    );
    chmodSync(path, 0o700);
    return path;
  };
  const recorderPath = makeRecorder("record-hook.sh", logPath);
  const toolRecorderPath = makeRecorder("record-tool-hook.sh", toolLogPath);

  const hook = { hooks: [{ type: "command", command: shq(recorderPath) }] };
  const toolHook = { matcher: "Bash", hooks: [{ type: "command", command: shq(toolRecorderPath) }] };
  const settingsPath = join(root, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [hook],
        // x1: an unexpected approval becomes an event-sequence mismatch.
        PermissionRequest: [hook],
        // Kept in a separate log so x1 can prove Bash ran successfully while
        // the primary completion sequence stays SessionStart -> Stop.
        PreToolUse: [toolHook],
        PostToolUse: [toolHook],
        PostToolUseFailure: [toolHook],
        Stop: [hook],
        StopFailure: [hook],
      },
    }),
    { mode: 0o600 },
  );
  return { root, project, logPath, toolLogPath, settingsPath };
}

function argv(harness: Harness, ...args: string[]): string[] {
  return [
    CLAUDE!,
    "--settings", harness.settingsPath,
    "--setting-sources", "project",
    "--model", "haiku",
    ...args,
  ];
}

async function runCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  const proc = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, COMMAND_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  return { exitCode, stdout, stderr, timedOut };
}

function readEvents(path: string): HookEvent[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`hook log line ${index + 1} is not JSON: ${String(error)}`);
    }
    if (
      typeof value !== "object" || value === null ||
      typeof (value as Record<string, unknown>).hook_event_name !== "string"
    ) {
      throw new Error(`hook log line ${index + 1} has no string hook_event_name`);
    }
    return value as HookEvent;
  });
}

function observedShape(events: readonly HookEvent[]): Array<{ name: string; keys: string[] }> {
  return events.map((event) => ({ name: event.hook_event_name, keys: Object.keys(event).sort() }));
}

function renderShapeDiff(expected: readonly ExpectedEvent[], events: readonly HookEvent[]): string {
  const observed = observedShape(events);
  const lines = [
    "shape diff:",
    `- expected sequence: ${expected.map((event) => event.name).join(" -> ") || "(none)"}`,
    `+ observed sequence: ${observed.map((event) => event.name).join(" -> ") || "(none)"}`,
  ];
  for (let index = 0; index < Math.max(expected.length, observed.length); index++) {
    const want = expected[index];
    const got = observed[index];
    lines.push(`  [${index}] ${want?.name ?? "(none)"} / ${got?.name ?? "(none)"}`);
    lines.push(`  - required keys: ${want ? [...want.requiredKeys].sort().join(", ") : "(none)"}`);
    lines.push(`  + observed keys: ${got?.keys.join(", ") ?? "(none)"}`);
    if (want && got) {
      const missing = want.requiredKeys.filter((key) => !got.keys.includes(key));
      const added = got.keys.filter((key) => !want.requiredKeys.includes(key));
      if (missing.length) lines.push(`  ! missing keys: ${missing.join(", ")}`);
      if (added.length) lines.push(`  + additive keys: ${added.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function resultTail(result: CommandResult): string {
  const tail = (value: string) => value.trim().slice(-1_500) || "(empty)";
  return [
    `exit=${result.exitCode} timedOut=${result.timedOut}`,
    `stdout tail: ${tail(result.stdout)}`,
    `stderr tail: ${tail(result.stderr)}`,
  ].join("\n");
}

function assertContract(
  label: string,
  expected: readonly ExpectedEvent[],
  events: readonly HookEvent[],
  result: CommandResult,
  expectedSource?: "startup" | "resume",
  expectedSessionId?: string,
): string {
  const issues: string[] = [];
  const expectedNames = expected.map((event) => event.name);
  const observedNames = events.map((event) => event.hook_event_name);
  if (JSON.stringify(expectedNames) !== JSON.stringify(observedNames)) {
    issues.push("event sequence changed");
  }
  for (let index = 0; index < expected.length; index++) {
    const want = expected[index];
    const got = events[index];
    if (!want || !got) continue;
    const keys = Object.keys(got);
    const missing = want.requiredKeys.filter((key) => !keys.includes(key));
    if (missing.length) issues.push(`${want.name} is missing: ${missing.join(", ")}`);
  }

  const start = events[0];
  const sessionId = start?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    issues.push("first event session_id is not a non-empty string");
  }
  if (expectedSource !== undefined && start?.source !== expectedSource) {
    issues.push(`SessionStart.source expected ${expectedSource}, observed ${String(start?.source)}`);
  }
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    issues.push(`resume session_id expected ${expectedSessionId}, observed ${String(sessionId)}`);
  }
  const terminalSessionId = events.at(-1)?.session_id;
  if (typeof sessionId === "string" && terminalSessionId !== sessionId) {
    issues.push(`terminal event session_id expected ${sessionId}, observed ${String(terminalSessionId)}`);
  }

  if (issues.length) {
    throw new Error(
      `[cc-contract:${label}] ${issues.join("; ")}\n${renderShapeDiff(expected, events)}\n${resultTail(result)}`,
    );
  }
  return sessionId as string;
}

function requireSuccessfulCommand(label: string, result: CommandResult): void {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`[cc-contract:${label}] claude command failed\n${resultTail(result)}`);
  }
}

function logShape(label: string, events: readonly HookEvent[]): void {
  const excerpt = observedShape(events)
    .map((event) => `${event.name}{${event.keys.join(",")}}`)
    .join(" -> ");
  console.log(`[cc-contract] ${label}: ${excerpt}`);
}

describe.skipIf(!CAN_RUN).serial("Claude Code live hook contract", () => {
  test("trivial auto-mode Bash turn emits SessionStart -> Stop without prompting (x1)", async () => {
    const harness = createHarness("success");
    const cmd = argv(
      harness,
      "--permission-mode", "auto",
      "--print",
      "Use the Bash tool exactly once to run exactly: printf CODEGENT_AUTO_BASH_OK. " +
        "Do not use any other tool. Then reply exactly AUTO_OK.",
    );
    const result = await runCommand(cmd, harness.project, scrubAgentEnv(process.env));
    const events = readEvents(harness.logPath);
    const sessionId = assertContract("x1-auto", SUCCESS_CONTRACT, events, result, "startup");
    requireSuccessfulCommand("x1-auto", result);
    const toolEvents = readEvents(harness.toolLogPath);
    assertContract("x1-auto-bash", BASH_TOOL_CONTRACT, toolEvents, result, undefined, sessionId);
    if (toolEvents.some((event) => event.tool_name !== "Bash")) {
      throw new Error(`[cc-contract:x1-auto-bash] observed a non-Bash tool\n${resultTail(result)}`);
    }
    const toolInput = toolEvents[0]?.tool_input as Record<string, unknown> | undefined;
    const toolResponse = toolEvents[1]?.tool_response as Record<string, unknown> | undefined;
    if (
      toolInput?.command !== "printf CODEGENT_AUTO_BASH_OK" ||
      toolResponse?.stdout !== "CODEGENT_AUTO_BASH_OK"
    ) {
      throw new Error(
        `[cc-contract:x1-auto-bash] Bash command/output changed: ` +
          `${JSON.stringify({ toolInput, toolResponse })}\n${resultTail(result)}`,
      );
    }
    logShape("x1 auto argv=--permission-mode auto --model haiku; observed", events);
    logShape("x1 Bash execution observed", toolEvents);
  });

  test("synthetic API 400 emits StopFailure only and ANTHROPIC env preserves resume (x2)", async () => {
    const harness = createHarness("failure-resume");
    const syntheticErrorMarker = `CODEGENT_CC_SYNTHETIC_400_${crypto.randomUUID()}`;
    let requestCount = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requestCount += 1;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: syntheticErrorMarker },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const failureEnv = scrubAgentEnv({
        ...process.env,
        ANTHROPIC_API_KEY: DUMMY_API_KEY,
        ANTHROPIC_BASE_URL: server.url.origin,
      });
      if (
        failureEnv.ANTHROPIC_API_KEY !== DUMMY_API_KEY ||
        failureEnv.ANTHROPIC_BASE_URL !== server.url.origin
      ) {
        throw new Error("scrubAgentEnv removed an ANTHROPIC presence probe");
      }
      const failureResult = await runCommand(
        argv(harness, "--print", "Reply exactly OK."),
        harness.project,
        failureEnv,
      );
      const failureEvents = readEvents(harness.logPath);
      const stopFailure = failureEvents.find((event) => event.hook_event_name === "StopFailure");
      const stopFailurePayload = JSON.stringify(stopFailure);
      if (requestCount < 1) {
        throw new Error(
          `[cc-contract:stop-failure] synthetic server requestCount=0; ` +
            "claude may have ignored ANTHROPIC_BASE_URL, so a remote failure cannot satisfy this contract\n" +
            resultTail(failureResult),
        );
      }
      if (!stopFailurePayload?.includes(syntheticErrorMarker)) {
        throw new Error(
          `[cc-contract:stop-failure] synthetic server requestCount=${requestCount}, but ` +
            `the StopFailure payload did not contain marker ${syntheticErrorMarker}; ` +
            `observed=${stopFailurePayload ?? "(missing)"}\n${resultTail(failureResult)}`,
        );
      }
      console.log(
        `[cc-contract] forced 400 provenance: requestCount=${requestCount} ` +
          `marker=${syntheticErrorMarker} markerCorrelated=true`,
      );
      const sessionId = assertContract(
        "stop-failure", FAILURE_CONTRACT, failureEvents, failureResult, "startup",
      );
      if (failureResult.timedOut) {
        throw new Error(`[cc-contract:stop-failure] claude command timed out\n${resultTail(failureResult)}`);
      }
      const transcriptPath = failureEvents[0]?.transcript_path;
      if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) {
        throw new Error(
          `[cc-contract:x2] transcript did not persist at ${String(transcriptPath)}\n` +
            `${renderShapeDiff(FAILURE_CONTRACT, failureEvents)}\n${resultTail(failureResult)}`,
        );
      }
      logShape(
        `forced 400 env=ANTHROPIC_API_KEY=<dummy>,ANTHROPIC_BASE_URL=${server.url.origin}; observed`,
        failureEvents,
      );

      writeFileSync(harness.logPath, "");
      const inheritedApiKey = process.env.ANTHROPIC_API_KEY ?? "";
      const resumeEnv = scrubAgentEnv({
        ...process.env,
        ANTHROPIC_API_KEY: inheritedApiKey,
        ANTHROPIC_BASE_URL: DEFAULT_ANTHROPIC_BASE_URL,
      });
      if (
        !("ANTHROPIC_API_KEY" in resumeEnv) ||
        resumeEnv.ANTHROPIC_BASE_URL !== DEFAULT_ANTHROPIC_BASE_URL
      ) {
        throw new Error("scrubAgentEnv removed an ANTHROPIC resume presence probe");
      }
      const resumeResult = await runCommand(
        argv(harness, "--resume", sessionId, "--print", "Reply exactly RESUME_OK."),
        harness.project,
        resumeEnv,
      );
      const resumeEvents = readEvents(harness.logPath);
      assertContract("resume", RESUME_CONTRACT, resumeEvents, resumeResult, "resume", sessionId);
      requireSuccessfulCommand("resume", resumeResult);
      logShape(
        `x2 resume env=ANTHROPIC_API_KEY=<${inheritedApiKey ? "inherited" : "empty-presence"}>,` +
          `ANTHROPIC_BASE_URL=${DEFAULT_ANTHROPIC_BASE_URL}; observed`,
        resumeEvents,
      );
    } finally {
      await server.stop(true);
    }
  });
});
