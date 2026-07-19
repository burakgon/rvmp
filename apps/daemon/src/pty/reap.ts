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

async function psSnapshot(): Promise<PidRow[]> {
  try {
    const p = Bun.spawn({ cmd: ["ps", "-ax", "-o", "pid=,pgid="], stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    if (code !== 0) return [];
    const rows: PidRow[] = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]) });
    }
    return rows;
  } catch {
    return [];
  }
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
