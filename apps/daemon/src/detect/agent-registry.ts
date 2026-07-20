/**
 * Content-free process recognition for the universal terminal-state tier.
 *
 * Recognition is intentionally limited to the concrete patterns recorded in:
 * - `docs/research/orca-agent-state.md` §2.3: package-manager module paths such
 *   as `node_modules/@openai/codex/`, Python `-m`, and the
 *   `codex-aarch64-*` packaged binary (`agent-process-recognition.ts:51-96,
 *   284-320`).
 * - `docs/research/herdr-agent-state.md` §3a: node/bun/python/shell argv
 *   unwrapping, npm paths (including `node_modules/@anthropic-ai/claude-code/`
 *   and `node_modules/@openai/codex/`), and the Nix `.codex-wrapped` argv0
 *   (`src/detect/mod.rs:321-606`).
 *
 * A runtime executing an arbitrary file named `claude` or `codex` is not one
 * of those patterns. Official executable names are recognized only as the
 * command itself (or as an explicit package-runner target), while interpreter
 * entrypoints must match a recorded package path/module.
 */

export interface AgentRegistryEntry {
  /** Stable label emitted by Layer 1. */
  readonly name: string;
  /** Exact executable basenames, matched case-insensitively without platform extensions. */
  readonly binaries: readonly string[];
  /** Package path fragments accepted only when they are an interpreter entrypoint. */
  readonly nodePackagePaths: readonly string[];
  /** Python `-m` module roots. */
  readonly pythonModules: readonly string[];
  /** Python package path fragments accepted only for a script entrypoint. */
  readonly pythonPackagePaths: readonly string[];
  /** Native packaged executable prefixes such as `codex-aarch64-*`. */
  readonly packagedBinaryPrefixes: readonly string[];
}

const noPaths: readonly string[] = [];

export const AGENT_REGISTRY: readonly AgentRegistryEntry[] = [
  {
    name: "claude",
    binaries: ["claude", "claude-code"],
    nodePackagePaths: ["node_modules/@anthropic-ai/claude-code/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
  },
  {
    name: "codex",
    binaries: ["codex"],
    nodePackagePaths: ["node_modules/@openai/codex/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: ["codex-aarch64-"],
  },
  {
    name: "gemini",
    binaries: ["gemini"],
    nodePackagePaths: ["node_modules/@google/gemini-cli/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
  },
  {
    name: "opencode",
    binaries: ["opencode", "open-code"],
    nodePackagePaths: ["node_modules/opencode-ai/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
  },
  {
    name: "aider",
    binaries: ["aider"],
    nodePackagePaths: noPaths,
    pythonModules: ["aider", "aider_chat"],
    pythonPackagePaths: ["site-packages/aider/", "site-packages/aider_chat/"],
    packagedBinaryPrefixes: noPaths,
  },
  {
    name: "amp",
    binaries: ["amp", "amp-local"],
    nodePackagePaths: ["node_modules/@sourcegraph/amp/"],
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
  },
  {
    name: "goose",
    binaries: ["goose"],
    nodePackagePaths: noPaths,
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
  },
  {
    name: "generic",
    binaries: noPaths,
    nodePackagePaths: noPaths,
    pythonModules: noPaths,
    pythonPackagePaths: noPaths,
    packagedBinaryPrefixes: noPaths,
  },
];

const PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat)$/i;
const PYTHON_RE = /^python(?:\d+(?:\.\d+)*)?$/;
const NODE_RE = /^(?:node|nodejs)$/;
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "mksh"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const NODE_OPTIONS_WITH_VALUE = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
]);
const NODE_INLINE_SOURCE_OPTIONS = new Set(["-e", "--eval", "-p", "--print", "--check"]);
const PYTHON_OPTIONS_WITH_VALUE = new Set(["-W", "-X"]);
const CLAUDE_HEADLESS_FLAGS = new Set(["-p", "--print"]);
const CLAUDE_HEADLESS_FORMATS = new Set(["json", "stream-json"]);
/**
 * Deliberate safety bound for recursively nested shell/runtime command lines.
 * Eight layers cover normal wrapper stacks while bounding work on untrusted
 * argv. A legitimate deeper stack can become a generic false negative; that is
 * the accepted tradeoff for predictable classification cost.
 */
const MAX_UNWRAP_DEPTH = 8;

function comparablePath(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/").toLowerCase();
}

function basename(value: string): string {
  const comparable = comparablePath(value);
  return comparable.split("/").filter(Boolean).pop() ?? comparable;
}

function normalizedExecutable(value: string | undefined): string {
  return value ? basename(value).replace(PROCESS_EXTENSION_RE, "") : "";
}

function matchExecutable(value: string): string | null {
  const normalized = normalizedExecutable(value);
  if (!normalized) return null;

  for (const entry of AGENT_REGISTRY) {
    if (entry.name === "generic") continue;
    if (
      entry.binaries.includes(normalized) ||
      entry.packagedBinaryPrefixes.some((prefix) => normalized.startsWith(prefix))
    ) {
      return entry.name;
    }
  }
  return null;
}

function matchPackagePath(value: string, field: "nodePackagePaths" | "pythonPackagePaths"): string | null {
  const path = comparablePath(value);
  for (const entry of AGENT_REGISTRY) {
    if (entry.name === "generic") continue;
    if (entry[field].some((marker) => path.includes(marker))) return entry.name;
  }
  return null;
}

function matchPythonModule(value: string | undefined): string | null {
  if (!value || value.startsWith("-")) return null;
  const module = value.toLowerCase().replace(/-/g, "_");
  const root = module.split(".", 1)[0] ?? module;
  for (const entry of AGENT_REGISTRY) {
    if (entry.name === "generic") continue;
    if (entry.pythonModules.some((candidate) => candidate === module || candidate === root)) {
      return entry.name;
    }
  }
  return null;
}

/** Small argv scanner: preserves quoted spaces and the Windows path separators that are not escapes. */
function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = commandLine[index + 1];
      if (next && (/\s/.test(next) || next === "'" || next === '"' || next === "\\")) {
        escaped = true;
        continue;
      }
    }
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function optionName(token: string): string {
  return token.split("=", 1)[0]?.toLowerCase() ?? "";
}

function optionValue(tokens: readonly string[], index: number): string | undefined {
  const token = tokens[index] ?? "";
  const equals = token.indexOf("=");
  return equals === -1 ? tokens[index + 1] : token.slice(equals + 1);
}

function isHeadlessClaude(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const name = optionName(tokens[index] ?? "");
    if (CLAUDE_HEADLESS_FLAGS.has(name)) return true;
    if (name === "--output-format") {
      const format = optionValue(tokens, index)?.toLowerCase();
      if (format && CLAUDE_HEADLESS_FORMATS.has(format)) return true;
    }
  }
  return false;
}

function accept(agent: string | null, invocation: readonly string[]): string | null {
  // Orca `agent-process-recognition.ts:288-294`, recorded in
  // `docs/research/orca-agent-state.md` §2.3: one-shot Claude print mode is
  // deliberately excluded from interactive/TUI identity.
  if (agent === "claude" && isHeadlessClaude(invocation)) return null;
  return agent;
}

function stripCommandPrefixes(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]?.toLowerCase() ?? "";
    if (["&", ".", "call", "command", "exec"].includes(token)) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
      index += 1;
      continue;
    }
    if (token === "env") {
      index += 1;
      while (
        index < tokens.length &&
        ((tokens[index] ?? "").startsWith("-") ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? ""))
      ) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function recognizeCommandPayload(
  payload: string,
  trailing: readonly string[],
  depth: number,
): string | null {
  return recognizeTokens([...tokenize(payload), ...trailing], depth + 1);
}

function findNodeEntrypoint(tokens: readonly string[]): number | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return index + 1 < tokens.length ? index + 1 : null;
    if (token.startsWith("-")) {
      const name = optionName(token);
      if (NODE_INLINE_SOURCE_OPTIONS.has(name)) return null;
      if (NODE_OPTIONS_WITH_VALUE.has(name) && token === name) index += 1;
      continue;
    }
    return index;
  }
  return null;
}

function recognizeNode(tokens: readonly string[]): string | null {
  const index = findNodeEntrypoint(tokens);
  if (index === null) return null;
  const entrypoint = tokens[index] ?? "";
  const invocation = [entrypoint, ...tokens.slice(index + 1)];
  // Interpreter entrypoints are package paths, never basename guesses. This
  // keeps `node /tmp/claude.js` distinct from the official `claude` command.
  const agent = matchPackagePath(entrypoint, "nodePackagePaths");
  return agent ? accept(agent, invocation) : null;
}

function recognizeBunPackageRunner(
  tokens: readonly string[],
  packageIndex: number,
): string | null {
  const target = tokens[packageIndex] ?? "";
  // `bun x`/`bunx` take a package/bin name here. Paths remain interpreter
  // entrypoints and must pass the package-path rules instead.
  if (!target || target.includes("/") || target.includes("\\") || target.startsWith(".")) {
    return null;
  }
  return accept(matchExecutable(target), [target, ...tokens.slice(packageIndex + 1)]);
}

function recognizeBun(tokens: readonly string[], bunx: boolean): string | null {
  if (bunx) return recognizeBunPackageRunner(tokens, 1);
  if ((tokens[1] ?? "").toLowerCase() === "x") return recognizeBunPackageRunner(tokens, 2);
  return recognizeNode(tokens);
}

function recognizePython(tokens: readonly string[]): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      const entrypoint = tokens[index + 1];
      if (!entrypoint) return null;
      const invocation = [entrypoint, ...tokens.slice(index + 2)];
      const agent = matchPackagePath(entrypoint, "pythonPackagePaths");
      return agent ? accept(agent, invocation) : null;
    }
    if (token === "-m") {
      const module = tokens[index + 1];
      return accept(matchPythonModule(module), [module ?? "", ...tokens.slice(index + 2)]);
    }
    if (token === "-c") return null;
    if (token.startsWith("-")) {
      const name = optionName(token);
      if (PYTHON_OPTIONS_WITH_VALUE.has(name) && token === name) index += 1;
      continue;
    }
    const invocation = [token, ...tokens.slice(index + 1)];
    // As with Node, a Python script basename is not agent identity. Only a
    // documented module or installed package path is accepted.
    const agent = matchPackagePath(token, "pythonPackagePaths");
    return agent ? accept(agent, invocation) : null;
  }
  return null;
}

function recognizeShell(tokens: readonly string[], depth: number): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--command" || /^-[^-]*c[^-]*$/.test(lower)) {
      const payload = tokens[index + 1];
      return payload ? recognizeCommandPayload(payload, tokens.slice(index + 2), depth) : null;
    }
    if (token === "--") {
      return null;
    }
    if (token.startsWith("-")) continue;
    // A positional shell argument is a script file, not an executable command.
    return null;
  }
  return null;
}

function recognizeCmd(tokens: readonly string[], depth: number): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = (tokens[index] ?? "").toLowerCase();
    if (flag === "/c" || flag === "/k") {
      const payload = tokens[index + 1];
      return payload ? recognizeCommandPayload(payload, tokens.slice(index + 2), depth) : null;
    }
  }
  return null;
}

function recognizePowerShell(tokens: readonly string[], depth: number): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = (tokens[index] ?? "").toLowerCase();
    if (["-file", "-f", "/file"].includes(flag)) {
      // `-File` names a script; its basename alone is not agent identity.
      return null;
    }
    if (["-command", "-c", "/command", "/c"].includes(flag)) {
      const payload = tokens[index + 1];
      return payload ? recognizeCommandPayload(payload, tokens.slice(index + 2), depth) : null;
    }
    if (["-encodedcommand", "-enc", "/encodedcommand", "/enc"].includes(flag)) return null;
  }
  return null;
}

function recognizeRecordedNixWrapper(tokens: readonly string[]): string | null {
  // herdr §3a records this exact argv0 shape. A `nixpkgs#codex` package
  // reference is configuration text, not evidence of the running executable.
  return normalizedExecutable(tokens[0]) === ".codex-wrapped" ? accept("codex", tokens) : null;
}

function recognizeTokens(rawTokens: readonly string[], depth: number): string | null {
  if (depth > MAX_UNWRAP_DEPTH) return null;
  const tokens = stripCommandPrefixes(rawTokens);
  if (tokens.length === 0) return null;

  const direct = matchExecutable(tokens[0] ?? "");
  if (direct) return accept(direct, tokens);

  const runtime = normalizedExecutable(tokens[0]);
  if (NODE_RE.test(runtime)) return recognizeNode(tokens);
  if (runtime === "bun") return recognizeBun(tokens, false);
  if (runtime === "bunx") return recognizeBun(tokens, true);
  if (PYTHON_RE.test(runtime)) return recognizePython(tokens);
  if (SHELLS.has(runtime)) return recognizeShell(tokens, depth);
  if (runtime === "cmd") return recognizeCmd(tokens, depth);
  if (POWERSHELLS.has(runtime)) return recognizePowerShell(tokens, depth);
  if (runtime === ".codex-wrapped") return recognizeRecordedNixWrapper(tokens);
  return null;
}

/** Recognize one interactive agent command line, or `null` when no TUI rule matches. */
export function recognizeAgentCommand(commandLine: string): string | null {
  return recognizeTokens(tokenize(commandLine), 0);
}
