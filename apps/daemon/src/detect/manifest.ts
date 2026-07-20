import type { ScreenGrid } from "./types";

export const DEFAULT_KNOWN_AGENT_IDLE_FALLBACK = "default_known_agent_idle_fallback";

const MAX_RULES = 128;
const MAX_GATE_DEPTH = 8;
const MAX_TOTAL_GATES = 512;
const MAX_TOTAL_MATCHERS = 1_024;
const MAX_MATCHER_CHARS = 512;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

/**
 * Complexity limits mirror Herdr `src/detect/manifest.rs:264-269`, as recorded
 * in `docs/research/herdr-agent-state.md` §3b. They bound load-time work before
 * any user-supplied regular expression can reach evaluation.
 */
const MANIFEST_LIMITS = {
  rules: MAX_RULES,
  gateDepth: MAX_GATE_DEPTH,
  gates: MAX_TOTAL_GATES,
  matchers: MAX_TOTAL_MATCHERS,
  matcherChars: MAX_MATCHER_CHARS,
} as const;

export type ManifestState = "idle" | "working" | "blocked" | "unknown";

export type Region =
  | "whole_recent"
  | `bottom_lines(${number})`
  | `bottom_non_empty_lines(${number})`
  | `top_non_empty_lines(${number})`
  | "prompt_box_body"
  | "above_prompt_box"
  | "after_last_horizontal_rule"
  | "osc_title"
  | "osc_progress";

export interface ManifestGate {
  readonly contains: readonly string[];
  readonly regex: readonly string[];
  readonly line_regex: readonly string[];
  readonly all: readonly ManifestGate[];
  readonly any: readonly ManifestGate[];
  readonly not: readonly ManifestGate[];
}

export interface ManifestRule extends ManifestGate {
  readonly id: string;
  readonly state: ManifestState;
  readonly priority: number;
  readonly region: Region;
  readonly skip_state_update: boolean;
}

export interface Manifest {
  readonly rules: readonly ManifestRule[];
}

export type Evaluation =
  | {
      state: ManifestState;
      ruleId: string;
      fallback: boolean;
    }
  | {
      state: "unknown";
      ruleId: string;
      fallback: false;
      freeze: true;
    };

export class ManifestLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestLoadError";
  }
}

interface CompiledGate {
  contains: readonly string[];
  regex: readonly RegExp[];
  lineRegex: readonly RegExp[];
  all: readonly CompiledGate[];
  any: readonly CompiledGate[];
  not: readonly CompiledGate[];
}

interface CompiledRule {
  gate: CompiledGate;
}

interface Complexity {
  gates: number;
  matchers: number;
}

interface ParsedGate {
  publicGate: ManifestGate;
  compiledGate: CompiledGate;
}

const COMPILED_RULES: unique symbol = Symbol("compiled manifest rules");

interface LoadedManifest extends Manifest {
  readonly [COMPILED_RULES]: readonly CompiledRule[];
}

const STATES = new Set<ManifestState>(["idle", "working", "blocked", "unknown"]);
const STATIC_REGIONS = new Set<Region>([
  "whole_recent",
  "prompt_box_body",
  "above_prompt_box",
  "after_last_horizontal_rule",
  "osc_title",
  "osc_progress",
]);
const COUNTED_REGION = /^(bottom_lines|bottom_non_empty_lines|top_non_empty_lines)\((\d+)\)$/u;

/** Parse, validate, bound, and precompile a TOML screen-pattern manifest. */
export function loadManifest(toml: string): Manifest {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(toml);
  } catch (error) {
    throw new ManifestLoadError(`Invalid manifest TOML: ${errorMessage(error)}`);
  }

  const root = expectRecord(parsed, "manifest root");
  const rawRules = root.rules;
  if (!Array.isArray(rawRules)) invalid('manifest must define a TOML "[[rules]]" list');
  if (rawRules.length === 0) invalid("manifest must contain at least one rule");
  if (rawRules.length > MANIFEST_LIMITS.rules) {
    invalid(`manifest contains ${rawRules.length} rules; maximum is ${MANIFEST_LIMITS.rules}`);
  }

  const complexity: Complexity = { gates: 0, matchers: 0 };
  const rules: ManifestRule[] = [];
  const compiledRules: CompiledRule[] = [];

  for (const [index, value] of rawRules.entries()) {
    const rawRule = expectRecord(value, `rule at index ${index}`);
    const id = requiredString(rawRule, "id", `rule at index ${index}`).trim();
    if (id.length === 0) invalid(`rule at index ${index} has an empty id`);

    const context = `rule ${id}`;
    const state = parseState(rawRule.state, context);
    const priority = parsePriority(rawRule.priority, context);
    const region = parseRegion(rawRule.region, context);
    const skipStateUpdate = optionalBoolean(rawRule, "skip_state_update", false, context);
    if (skipStateUpdate && state !== "unknown") {
      invalid(`${context} uses skip_state_update without state = "unknown"`);
    }

    const { publicGate, compiledGate } = parseGate(rawRule, context, 0, complexity, true);
    const rule = Object.freeze({
      ...publicGate,
      id,
      state,
      priority,
      region,
      skip_state_update: skipStateUpdate,
    });
    rules.push(rule);
    compiledRules.push(Object.freeze({ gate: compiledGate }));
  }

  const manifest = { rules: Object.freeze(rules) } as LoadedManifest;
  Object.defineProperty(manifest, COMPILED_RULES, {
    value: Object.freeze(compiledRules),
    enumerable: false,
  });
  Object.freeze(manifest);
  return manifest;
}

/**
 * Highest-priority matching rule wins; equal priorities retain file order.
 * This is Herdr `src/detect/manifest.rs:423-446` (research §3b).
 */
export function evaluate(manifest: Manifest, grid: ScreenGrid): Evaluation {
  const compiledRules = (manifest as LoadedManifest)[COMPILED_RULES];
  if (!compiledRules || compiledRules.length !== manifest.rules.length) {
    throw new TypeError("evaluate requires a manifest returned by loadManifest");
  }

  let winner: ManifestRule | null = null;
  const regionCache = new Map<Region, string>();

  for (let index = 0; index < manifest.rules.length; index += 1) {
    const rule = manifest.rules[index]!;
    let text = regionCache.get(rule.region);
    if (text === undefined) {
      text = extractRegion(grid, rule.region);
      regionCache.set(rule.region, text);
    }

    if (!gateMatches(compiledRules[index]!.gate, text)) continue;
    if (winner === null || rule.priority > winner.priority) winner = rule;
  }

  if (winner === null) {
    // Herdr `manifest.rs:14,526-541`: known-agent fallback is strictly Idle;
    // Blocked may only come from positive evidence (research §3b).
    return {
      state: "idle",
      ruleId: DEFAULT_KNOWN_AGENT_IDLE_FALLBACK,
      fallback: true,
    };
  }

  const rule = winner;
  if (rule.skip_state_update) {
    // Herdr `manifest.rs:909-922`: agent-owned viewer screens freeze the
    // previous state instead of replacing it with viewer text (research §3b).
    return {
      state: "unknown",
      ruleId: rule.id,
      fallback: false,
      freeze: true,
    };
  }

  return { state: rule.state, ruleId: rule.id, fallback: false };
}

function parseGate(
  raw: Record<string, unknown>,
  context: string,
  depth: number,
  complexity: Complexity,
  requirePositive: boolean,
): ParsedGate {
  if (depth > MANIFEST_LIMITS.gateDepth) {
    invalid(`${context} exceeds maximum gate depth ${MANIFEST_LIMITS.gateDepth}`);
  }
  complexity.gates += 1;
  if (complexity.gates > MANIFEST_LIMITS.gates) {
    invalid(`manifest exceeds gate count limit ${MANIFEST_LIMITS.gates}`);
  }

  const contains = stringArray(raw, "contains", context);
  const regex = stringArray(raw, "regex", context);
  const lineRegex = stringArray(raw, "line_regex", context);
  const rawAll = gateArray(raw, "all", context);
  const rawAny = gateArray(raw, "any", context);
  const rawNot = gateArray(raw, "not", context);

  const matcherCount = contains.length + regex.length + lineRegex.length;
  complexity.matchers += matcherCount;
  if (complexity.matchers > MANIFEST_LIMITS.matchers) {
    invalid(`manifest exceeds matcher count limit ${MANIFEST_LIMITS.matchers}`);
  }
  for (const matcher of [...contains, ...regex, ...lineRegex]) {
    let chars = 0;
    for (const _character of matcher) {
      chars += 1;
      if (chars > MANIFEST_LIMITS.matcherChars) {
        invalid(`${context} matcher exceeds maximum length ${MANIFEST_LIMITS.matcherChars}`);
      }
    }
  }

  const hasPositiveMatcher =
    matcherCount > 0 || rawAll.length > 0 || rawAny.length > 0;
  const hasAnyMatcher = hasPositiveMatcher || rawNot.length > 0;
  if (requirePositive && !hasPositiveMatcher) invalid(`${context} must contain a positive matcher`);
  if (!requirePositive && !hasAnyMatcher) invalid(`${context} must contain a matcher`);

  const all = rawAll.map((gate, index) =>
    parseGate(gate, `${context} all[${index}]`, depth + 1, complexity, true),
  );
  const any = rawAny.map((gate, index) =>
    parseGate(gate, `${context} any[${index}]`, depth + 1, complexity, true),
  );
  const not = rawNot.map((gate, index) =>
    parseGate(gate, `${context} not[${index}]`, depth + 1, complexity, false),
  );

  const publicGate: ManifestGate = Object.freeze({
    contains: Object.freeze([...contains]),
    regex: Object.freeze([...regex]),
    line_regex: Object.freeze([...lineRegex]),
    all: Object.freeze(all.map((gate) => gate.publicGate)),
    any: Object.freeze(any.map((gate) => gate.publicGate)),
    not: Object.freeze(not.map((gate) => gate.publicGate)),
  });
  const compiledGate: CompiledGate = Object.freeze({
    contains: Object.freeze(contains.map((matcher) => matcher.toLowerCase())),
    regex: Object.freeze(regex.map((pattern) => compileRegex(pattern, context, "regex"))),
    lineRegex: Object.freeze(
      lineRegex.map((pattern) => compileRegex(pattern, context, "line_regex")),
    ),
    all: Object.freeze(all.map((gate) => gate.compiledGate)),
    any: Object.freeze(any.map((gate) => gate.compiledGate)),
    not: Object.freeze(not.map((gate) => gate.compiledGate)),
  });

  return { publicGate, compiledGate };
}

function compileRegex(pattern: string, context: string, field: string): RegExp {
  let source = pattern;
  let flags = "";
  const inlineFlags = source.match(/^\(\?([ims]+)\)/u);
  if (inlineFlags) {
    flags = Array.from(new Set(inlineFlags[1]!.split(""))).join("");
    source = source.slice(inlineFlags[0].length);
  }

  let usesCodePointEscape = false;
  source = source.replace(/\\x\{([0-9a-fA-F]{1,6})\}/gu, (_match, hexadecimal: string) => {
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint > 0x10ffff) {
      invalid(
        `${context} contains invalid ${field} pattern ${JSON.stringify(pattern)}: invalid code point`,
      );
    }
    usesCodePointEscape = true;
    return `\\u{${hexadecimal}}`;
  });
  if (usesCodePointEscape && !flags.includes("u")) flags += "u";

  try {
    return new RegExp(source, flags);
  } catch (error) {
    invalid(
      `${context} contains invalid ${field} pattern ${JSON.stringify(pattern)}: ${errorMessage(error)}`,
    );
  }
}

function gateMatches(
  gate: CompiledGate,
  text: string,
  lowerText = text.toLowerCase(),
  lines = text.split("\n"),
): boolean {
  if (!gate.contains.every((needle) => lowerText.includes(needle))) return false;
  if (!gate.regex.every((regex) => regex.test(text))) return false;

  if (!gate.lineRegex.every((regex) => lines.some((line) => regex.test(line)))) return false;
  if (!gate.all.every((nested) => gateMatches(nested, text, lowerText, lines))) return false;
  if (
    gate.any.length > 0 &&
    !gate.any.some((nested) => gateMatches(nested, text, lowerText, lines))
  ) {
    return false;
  }
  if (gate.not.some((nested) => gateMatches(nested, text, lowerText, lines))) return false;
  return true;
}

/** Regions mirror Herdr `src/detect/manifest.rs:1072-1095,1254-1292`. */
function extractRegion(grid: ScreenGrid, region: Region): string {
  if (region === "osc_title") return grid.oscTitle ?? "";
  if (region === "osc_progress") return grid.oscProgress ?? "";

  const rows = grid.rows;
  if (region === "whole_recent") return rows.join("\n");
  if (region === "prompt_box_body") {
    const borders = horizontalRuleIndexes(rows);
    if (borders.length < 2) return "";
    return rows.slice(borders.at(-2)! + 1, borders.at(-1)!).join("\n");
  }
  if (region === "above_prompt_box") {
    const borders = horizontalRuleIndexes(rows);
    return borders.length < 2 ? rows.join("\n") : rows.slice(0, borders.at(-2)!).join("\n");
  }
  if (region === "after_last_horizontal_rule") {
    let lastRule = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (!isHorizontalRule(rows[index]!)) continue;
      lastRule = index;
      break;
    }
    return rows.slice(lastRule + 1).join("\n");
  }

  const match = COUNTED_REGION.exec(region)!;
  const count = Number(match[2]);
  if (count === 0) return "";
  if (match[1] === "bottom_lines") return rows.slice(Math.max(0, rows.length - count)).join("\n");

  if (match[1] === "bottom_non_empty_lines") {
    let remaining = count;
    let start = rows.length;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]!.trim().length === 0) continue;
      start = index;
      remaining -= 1;
      if (remaining === 0) break;
    }
    return start === rows.length ? "" : rows.slice(start).join("\n");
  }

  let remaining = count;
  let lastNonEmpty = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.trim().length === 0) continue;
    lastNonEmpty = index;
    remaining -= 1;
    if (remaining === 0) return rows.slice(0, index + 1).join("\n");
  }
  return lastNonEmpty < 0 ? "" : rows.slice(0, lastNonEmpty + 1).join("\n");
}

function horizontalRuleIndexes(rows: readonly string[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (isHorizontalRule(rows[index]!)) indexes.push(index);
  }
  return indexes;
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let ruleChars = 0;
  while (trimmed[ruleChars] === "─") ruleChars += 1;
  if (ruleChars === 0) return false;
  return trimmed.slice(ruleChars).trimStart().length === 0 || ruleChars >= 3;
}

function parseState(value: unknown, context: string): ManifestState {
  if (typeof value !== "string" || !STATES.has(value as ManifestState)) {
    invalid(`${context} state must be idle, working, blocked, or unknown`);
  }
  return value as ManifestState;
}

function parsePriority(value: unknown, context: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < I32_MIN ||
    value > I32_MAX
  ) {
    invalid(`${context} priority must be a signed 32-bit integer`);
  }
  return value;
}

function parseRegion(value: unknown, context: string): Region {
  if (typeof value !== "string") invalid(`${context} region must be a string`);
  const region = value.trim();
  if (STATIC_REGIONS.has(region as Region)) return region as Region;

  const match = COUNTED_REGION.exec(region);
  if (!match || !Number.isSafeInteger(Number(match[2]))) {
    invalid(`${context} uses invalid region ${JSON.stringify(region)}`);
  }
  if (match[1] === "top_non_empty_lines" && match[2]!.startsWith("0")) {
    invalid(`${context} uses invalid region ${JSON.stringify(region)}`);
  }
  return region as Region;
}

function stringArray(raw: Record<string, unknown>, field: string, context: string): string[] {
  const value = raw[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(`${context} ${field} must be an array of strings`);
  }
  return [...(value as string[])];
}

function gateArray(
  raw: Record<string, unknown>,
  field: "all" | "any" | "not",
  context: string,
): Record<string, unknown>[] {
  const value = raw[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${context} ${field} must be an array of gates`);
  return value.map((entry, index) => expectRecord(entry, `${context} ${field}[${index}]`));
}

function requiredString(raw: Record<string, unknown>, field: string, context: string): string {
  const value = raw[field];
  if (typeof value !== "string") invalid(`${context} ${field} must be a string`);
  return value;
}

function optionalBoolean(
  raw: Record<string, unknown>,
  field: string,
  fallback: boolean,
  context: string,
): boolean {
  const value = raw[field];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") invalid(`${context} ${field} must be a boolean`);
  return value;
}

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${context} must be a table`);
  }
  return value as Record<string, unknown>;
}

function invalid(message: string): never {
  throw new ManifestLoadError(`Invalid manifest: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
