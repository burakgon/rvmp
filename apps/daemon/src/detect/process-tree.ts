import { recognizeAgentCommand } from "./agent-registry";
import { capturePsOutput } from "../pty/reap";

export interface PsSnapshotRow {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  command: string;
  /** Child-label projection populated by live enrichment or injected by a fixture. */
  env?: Readonly<{ CODEGENT_AGENT?: string }>;
}

export type PsSnapshot = readonly PsSnapshotRow[];

export interface ForegroundAgentResult {
  agent: string | null;
  pid: number | null;
}

export interface TrackedAgentResult extends ForegroundAgentResult {
  /** True only on the update that crosses the confirmed-gone threshold. */
  gone: boolean;
}

/** Caller cadence after identity: herdr `pane.rs:1969`, recorded in research §3. */
export const AGENT_POLL_IDENTIFIED_MS = 300;
/** Caller cadence before identity: herdr `pane.rs:1968`, recorded in research §3. */
export const AGENT_POLL_UNIDENTIFIED_MS = 500;
/** Shared-table cache TTL: Orca `process-table-snapshot.ts:13-22`, research §2.3. */
export const PS_SNAPSHOT_TTL_MS = 500;
/** Confirmed-gone threshold: herdr `pane.rs:248`, recorded in research §3. */
export const AGENT_MISS_LIMIT = 6;

interface Descendant extends PsSnapshotRow {
  depth: number;
}

function collectDescendants(snapshot: PsSnapshot, shellPid: number): Descendant[] {
  const children = new Map<number, PsSnapshotRow[]>();
  for (const process of snapshot) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }

  const descendants: Descendant[] = [];
  const visited = new Set<number>([shellPid]);
  const stack = (children.get(shellPid) ?? []).map((process) => ({ process, depth: 1 }));
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || visited.has(next.process.pid)) continue;
    visited.add(next.process.pid);
    descendants.push({ ...next.process, depth: next.depth });
    for (const child of children.get(next.process.pid) ?? []) {
      stack.push({ process: child, depth: next.depth + 1 });
    }
  }
  return descendants;
}

function candidateScore(process: Descendant): number {
  // Orca `agent-foreground-process.ts:43-48`, recorded in research §2.3:
  // `+` is the foreground process group and dominates wrapper-tree depth.
  return (process.stat.includes("+") ? 10_000 : 0) + process.depth;
}

function foregroundCandidates(shellPid: number, snapshot: PsSnapshot): Descendant[] {
  const shell = snapshot.find((process) => process.pid === shellPid);
  const descendants = collectDescendants(snapshot, shellPid);
  const foregroundIsKnown =
    shell?.stat.includes("+") === true || descendants.some((process) => process.stat.includes("+"));
  return descendants
    .filter((process) => !foregroundIsKnown || process.stat.includes("+"))
    .sort((left, right) => candidateScore(right) - candidateScore(left));
}

/**
 * Pure Layer-1 identity over one injected process-table snapshot.
 *
 * Primary identity does not originate here: the daemon spawns the agent PTY
 * and records its label at launch. The Task 6/7 classifier/adapter passes that
 * known-agent hint; process-tree evidence confirms or refines it rather than
 * acting as the sole source of identity. `CODEGENT_AGENT` is the fallback for
 * recovering that daemon-set label from a child when a wrapper hides argv.
 *
 * The shell itself is a foreground gate, not a candidate: if it owns `+`,
 * background descendants must not masquerade as a live agent. When a platform
 * supplies no `+`, descendant scoring still provides the documented fallback.
 */
export function foregroundAgent(shellPid: number, snapshot: PsSnapshot): ForegroundAgentResult {
  if (!Number.isInteger(shellPid) || shellPid <= 1) return { agent: null, pid: null };

  // Universal adapters spawn the bare CLI as the PTY leader, whereas shell
  // panes put it below an interactive shell. Accept a recognized root before
  // walking descendants so both process shapes share this classifier.
  const root = snapshot.find((process) => process.pid === shellPid);
  if (root) {
    const rootAgent = recognizeAgentCommand(root.command);
    if (rootAgent) return { agent: rootAgent, pid: root.pid };
    const rootLabel = root.env?.CODEGENT_AGENT?.trim();
    if (rootLabel) return { agent: rootLabel, pid: root.pid };
  }

  const candidates = foregroundCandidates(shellPid, snapshot);

  for (const candidate of candidates) {
    const agent = recognizeAgentCommand(candidate.command);
    if (agent) return { agent, pid: candidate.pid };
  }

  for (const candidate of candidates) {
    const label = candidate.env?.CODEGENT_AGENT?.trim();
    if (label) return { agent: label, pid: candidate.pid };
  }

  const generic = candidates[0];
  return generic ? { agent: "generic", pid: generic.pid } : { agent: null, pid: null };
}

/** Parse `ps -ax -o pid=,ppid=,pgid=,stat=,command=` without performing I/O. */
export function parsePsSnapshot(output: string): PsSnapshot {
  const rows: PsSnapshotRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      stat: match[4] ?? "",
      command: match[5] ?? "",
    });
  }
  return rows;
}

const CODEGENT_AGENT_ENV_PREFIX = "CODEGENT_AGENT=";

/** Parse a Linux `/proc/<pid>/environ` byte buffer (NUL-delimited entries). */
export function parseCodegentAgentFromEnviron(environ: Uint8Array): string | undefined {
  const entries = new TextDecoder().decode(environ).split("\0");
  for (const entry of entries) {
    if (!entry.startsWith(CODEGENT_AGENT_ENV_PREFIX)) continue;
    const label = entry.slice(CODEGENT_AGENT_ENV_PREFIX.length).trim();
    if (label) return label;
  }
  return undefined;
}

/**
 * Best-effort live child-label read. Linux exposes the inherited environment
 * at `/proc/<pid>/environ`; macOS and other platforms have no equivalent used
 * by this layer and are deliberately unsupported-live (return `undefined`).
 * Races, permission failures, and exited processes also degrade without error.
 */
export async function readCodegentAgentFromProcess(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    const environ = new Uint8Array(await Bun.file(`/proc/${pid}/environ`).arrayBuffer());
    return parseCodegentAgentFromEnviron(environ);
  } catch {
    return undefined;
  }
}

type AgentLabelReader = (pid: number) => Promise<string | undefined>;

/**
 * Populate the snapshot projection for foreground descendants only. Keeping
 * the reader injectable makes enrichment testable while `foregroundAgent`
 * remains pure over its supplied snapshot.
 */
export async function enrichPsSnapshotAgentLabels(
  shellPid: number,
  snapshot: PsSnapshot,
  readLabel: AgentLabelReader = readCodegentAgentFromProcess,
): Promise<PsSnapshot> {
  if (!Number.isInteger(shellPid) || shellPid <= 1) return snapshot;
  const labels = new Map<number, string>();
  await Promise.all(
    foregroundCandidates(shellPid, snapshot).map(async (candidate) => {
      const label = (await readLabel(candidate.pid))?.trim();
      if (label) labels.set(candidate.pid, label);
    }),
  );
  if (labels.size === 0) return snapshot;
  return snapshot.map((row) => {
    const label = labels.get(row.pid);
    return label ? { ...row, env: { ...row.env, CODEGENT_AGENT: label } } : row;
  });
}

/**
 * Thin live capture. The spawn/error mechanics are shared with the v0.2 pgid
 * reaper; cache/single-flight policy belongs to the Task-6 classifier caller.
 *
 * Passing the pane shell PID limits Linux environment reads to foreground
 * descendants that `foregroundAgent` can actually select. Only the single
 * `CODEGENT_AGENT` label is retained; whole process environments are not.
 */
export async function capturePsSnapshot(shellPid: number): Promise<PsSnapshot> {
  const output = await capturePsOutput("pid=,ppid=,pgid=,stat=,command=");
  return enrichPsSnapshotAgentLabels(shellPid, parsePsSnapshot(output));
}

/** Six-miss presence hysteresis adopted from herdr `pane.rs:248`. */
export class AgentTracker {
  private current: ForegroundAgentResult = { agent: null, pid: null };
  private consecutiveMisses = 0;

  update(result: ForegroundAgentResult): TrackedAgentResult {
    if (result.agent !== null) {
      this.current = { agent: result.agent, pid: result.pid };
      this.consecutiveMisses = 0;
      return { ...this.current, gone: false };
    }

    if (this.current.agent === null) {
      this.consecutiveMisses = 0;
      return { agent: null, pid: null, gone: false };
    }

    this.consecutiveMisses += 1;
    if (this.consecutiveMisses < AGENT_MISS_LIMIT) return { ...this.current, gone: false };

    this.current = { agent: null, pid: null };
    this.consecutiveMisses = 0;
    return { agent: null, pid: null, gone: true };
  }
}
