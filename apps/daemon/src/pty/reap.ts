import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Post-exit process-group reaping (spec §6.1 supervision; T8).
 *
 * Bun's `Subprocess.kill` signals the child PID only — no group-kill primitive
 * (probe-verified, docs/research/bun-pty-spike.md "Kill semantics"). The PTY
 * child is spawned as session + process-group leader, so its death makes the
 * kernel SIGHUP the foreground group — but HUP-immune grandchildren (leftover
 * MCP-server processes above all) survive both that cascade and the whole
 * terminate ladder. After a dispatch's session exits, the engine calls
 * `reapProcessGroup(pgid)` with the dead leader's pid (== pgid) to discover
 * survivors via `ps` and SIGKILL the group — `kill(2)` with a negative pgid,
 * i.e. exactly what `pkill -9 -g <pgid>` issues, minus the extra subprocess.
 */

interface PidRow {
  pid: number;
  pgid: number;
}

interface ProcessIdentity extends PidRow {
  /** Kernel process start stamp from portable `ps ... lstart=` output. */
  started: string;
}

interface ProcessGroupRecord {
  version: 1;
  pgid: number;
  dispatchId: string;
  recordedAt: number;
  members: Array<{ pid: number; started: string }>;
}

const PGID_MARKER = ".codegent-process-group.json";

const markerPath = (settingsDir: string): string => join(settingsDir, PGID_MARKER);

function parseIdentitySnapshot(output: string): ProcessIdentity[] {
  const rows: ProcessIdentity[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), pgid: Number(match[2]), started: match[3]!.trim() });
  }
  return rows;
}

/** Synchronous only because boot's existing settings-dir sweep is synchronous
 * and runs before the daemon starts accepting work. */
function identitySnapshotSync(): ProcessIdentity[] {
  try {
    const result = Bun.spawnSync({
      cmd: ["ps", "-ax", "-o", "pid=,pgid=,lstart="],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return [];
    return parseIdentitySnapshot(new TextDecoder().decode(result.stdout));
  } catch {
    return [];
  }
}

/** Persist the spawn-time group identity inside its already-durable
 * per-dispatch settings directory. Member start stamps make the next-boot
 * kill safe against PID/PGID reuse; any one surviving recorded member proves
 * the group is still the one this daemon created. Best-effort by design. */
export function recordProcessGroup(settingsDir: string, pgid: number, dispatchId: string): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    mkdirSync(settingsDir, { recursive: true });
    const members = identitySnapshotSync()
      .filter((row) => row.pgid === pgid)
      .map(({ pid, started }) => ({ pid, started }));
    const record: ProcessGroupRecord = {
      version: 1,
      pgid,
      dispatchId,
      recordedAt: Date.now(),
      members,
    };
    const path = markerPath(settingsDir);
    const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, path);
  } catch {
    // Marker persistence is supervision hardening, never a reason to fail an
    // otherwise healthy agent spawn.
  }
}

export function forgetProcessGroup(settingsDir: string): void {
  rmSync(markerPath(settingsDir), { force: true });
}

/** Next-boot counterpart to reapProcessGroup. It reads the durable marker,
 * verifies that a recorded PID still has both the same PGID and kernel start
 * stamp (so a recycled numeric PGID cannot kill an unrelated process), then
 * SIGKILLs the whole orphan group. Synchronous for sweepSettingsDirs(). */
export function reapRecordedProcessGroup(settingsDir: string): number[] {
  let record: ProcessGroupRecord;
  try {
    record = JSON.parse(readFileSync(markerPath(settingsDir), "utf8"));
  } catch {
    return [];
  }
  if (record?.version !== 1 || !Number.isInteger(record.pgid) || record.pgid <= 1
    || !Array.isArray(record.members)) {
    forgetProcessGroup(settingsDir);
    return [];
  }
  const rows = identitySnapshotSync();
  const own = rows.find((row) => row.pid === process.pid)?.pgid;
  if (own !== undefined && own === record.pgid) {
    forgetProcessGroup(settingsDir);
    return [];
  }
  const survivors = rows.filter((row) => row.pgid === record.pgid);
  if (survivors.length === 0) {
    forgetProcessGroup(settingsDir);
    return [];
  }
  const recorded = new Set(record.members.map((member) => `${member.pid}\0${member.started}`));
  const identityMatches = survivors.some((row) => recorded.has(`${row.pid}\0${row.started}`));
  if (!identityMatches) {
    console.warn(`[reap] refused stale process-group marker for dispatch ${record.dispatchId}`);
    forgetProcessGroup(settingsDir);
    return [];
  }
  try {
    process.kill(-record.pgid, "SIGKILL");
  } catch {
    // ESRCH (already gone) / EPERM (not ours) — boot continues either way.
  }
  forgetProcessGroup(settingsDir);
  return survivors.map((row) => row.pid);
}

/**
 * One shared `ps` subprocess seam for reaping and process-tree detection.
 * Callers own parse policy; failures intentionally degrade to an empty table.
 */
export async function capturePsOutput(columns: string): Promise<string> {
  try {
    const p = Bun.spawn({ cmd: ["ps", "-ax", "-o", columns], stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    return code === 0 ? out : "";
  } catch {
    return "";
  }
}

async function psSnapshot(): Promise<PidRow[]> {
  const out = await capturePsOutput("pid=,pgid=");
  const rows: PidRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]) });
  }
  return rows;
}

/** Live PIDs currently in the given process group (portable macOS/Linux `ps`). */
export async function listGroupPids(pgid: number): Promise<number[]> {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  return (await psSnapshot()).filter((r) => r.pgid === pgid).map((r) => r.pid);
}

/** The daemon's own process group id (used as a reaping refusal guard). */
export async function currentPgid(): Promise<number> {
  return (await psSnapshot()).find((r) => r.pid === process.pid)?.pgid ?? 0;
}

/**
 * SIGKILL every survivor of `pgid`. Returns the PIDs that were signalled.
 * Hard guards: pgid must be an integer > 1 (0/negative would signal our own
 * group or every process we may signal), and the daemon's own group is never
 * reaped, whatever the caller passes.
 */
export async function reapProcessGroup(pgid: number): Promise<number[]> {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  const rows = await psSnapshot();
  const own = rows.find((r) => r.pid === process.pid)?.pgid;
  if (own !== undefined && own === pgid) return []; // never our own group
  const survivors = rows.filter((r) => r.pgid === pgid).map((r) => r.pid);
  if (survivors.length === 0) return [];
  try {
    process.kill(-pgid, "SIGKILL"); // kill(2) group signal — pkill -9 -g semantics
  } catch {
    // ESRCH (already gone) / EPERM (not ours) — nothing more we can do.
  }
  return survivors;
}
