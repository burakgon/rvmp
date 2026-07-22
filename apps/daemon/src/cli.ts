#!/usr/bin/env bun
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import pkg from "../package.json";
import { AGENT_REGISTRY } from "./detect/agent-registry";
import { sidecarSpec } from "./agents/sidecar-spec";
import { disableService, enableService, serviceStatus, type ServiceDeps } from "./service";
import { databaseIntegrity, ensureDailyBackup } from "./store/db";

// The `rvmp` command (spec §14, local-only): start (+open), doctor,
// task add, service enable|disable|status, update, --version. The daemon
// itself is startDaemon() — imported lazily so light subcommands don't pay
// the boot-graph cost.

const PORT_BASE = 4666;
const PORT_MAX = 4766;

export type Parsed =
  | { cmd: "start"; open: boolean }
  | { cmd: "doctor" }
  | { cmd: "task-add"; title: string; project: string | null }
  | { cmd: "service"; action: "enable" | "disable" | "status" }
  | { cmd: "restore"; backup: string }
  | { cmd: "update" }
  | { cmd: "mcp-sidecar" }
  | { cmd: "version" }
  | { cmd: "help" }
  | { cmd: "error"; message: string };

export function parseCli(argv: string[]): Parsed {
  const [head, ...rest] = argv;
  if (head === undefined || head === "start") {
    return { cmd: "start", open: !argv.includes("--no-open") };
  }
  if (head === "--version" || head === "-v") return { cmd: "version" };
  if (head === "help" || head === "--help" || head === "-h") return { cmd: "help" };
  if (head === "doctor") return { cmd: "doctor" };
  if (head === "update") return { cmd: "update" };
  if (head === "restore") {
    if (!rest[0] || rest.length !== 1) return { cmd: "error", message: "usage: rvmp restore <backup-file>" };
    return { cmd: "restore", backup: rest[0] };
  }
  // Hidden: the compiled binary re-invoked as the per-dispatch MCP sidecar
  // (sidecar-spec.ts). Not in help — never typed by a human.
  if (head === "mcp-sidecar") return { cmd: "mcp-sidecar" };
  if (head === "service") {
    const action = rest[0];
    if (action === "enable" || action === "disable" || action === "status") return { cmd: "service", action };
    return { cmd: "error", message: "usage: rvmp service enable|disable|status" };
  }
  if (head === "task") {
    if (rest[0] !== "add" || !rest[1]) return { cmd: "error", message: 'usage: rvmp task add "<title>" [--project <path>]' };
    const pi = rest.indexOf("--project");
    return { cmd: "task-add", title: rest[1], project: pi >= 0 ? rest[pi + 1] ?? null : null };
  }
  return { cmd: "error", message: `unknown command '${head}' — try: rvmp help` };
}

export const HELP = `rvmp ${pkg.version} — local coding-agent orchestrator

  rvmp [start]            start the daemon and open the board (--no-open)
  rvmp doctor             environment checks (git, agents, port, service)
  rvmp task add "<t>"     add a card to the running daemon [--project <path>]
  rvmp service <action>   enable | disable | status (launchd / systemd --user)
  rvmp restore <backup>   restore a verified SQLite backup (daemon must be stopped)
  rvmp update             how to update
  rvmp --version
`;

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export interface DoctorDeps {
  which?: (bin: string) => string | null;
  service?: ServiceDeps;
  home?: string;
}

export type DoctorRow = { name: string; ok: boolean; detail: string };

export async function doctorReport(d?: DoctorDeps): Promise<DoctorRow[]> {
  const which = d?.which ?? ((bin: string) => Bun.which(bin));
  const home = d?.home ?? homedir();
  const rows: DoctorRow[] = [];

  const git = which("git");
  rows.push({ name: "git", ok: git !== null, detail: git ?? "not found — install git" });

  for (const agent of AGENT_REGISTRY) {
    if (agent.name === "generic") continue;
    const hit = agent.binaries.map((b) => which(b)).find((p) => p !== null) ?? null;
    rows.push({ name: `agent:${agent.name}`, ok: hit !== null, detail: hit ?? "missing" });
  }

  let port: number | null = null;
  for (let p = PORT_BASE; p < PORT_MAX; p++) {
    try {
      const l = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
      l.stop();
      port = p;
      break;
    } catch { /* busy — a running daemon also lands here, which is fine */ }
  }
  rows.push({ name: "port", ok: port !== null, detail: port !== null ? `${port} free` : `none free in ${PORT_BASE}-${PORT_MAX - 1} (daemon already running?)` });

  const dataDir = process.env.RVMP_DATA_DIR ?? join(home, ".rvmp");
  let writable = true;
  try {
    if (existsSync(dataDir)) accessSync(dataDir, constants.W_OK);
  } catch {
    writable = false;
  }
  rows.push({ name: "data dir", ok: writable, detail: `${dataDir}${writable ? "" : " — not writable"}` });

  rows.push({ name: "service", ok: true, detail: await serviceStatus(d?.service) });

  rows.push(await mcpSidecarProbe());
  return rows;
}

/** Live-spawn the MCP sidecar exactly as agent configs will (sidecar-spec) and
 * complete an initialize round-trip. This is the check that would have caught
 * the launch-day bug where installed systems generated a sidecar command no
 * machine could run — cards hung in `working` with nothing to explain why. */
async function mcpSidecarProbe(): Promise<DoctorRow> {
  const spec = sidecarSpec();
  const name = "mcp sidecar";
  try {
    const p = Bun.spawn({
      cmd: [spec.command, ...spec.args],
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: {
        ...process.env,
        RVMP_HOOK_PORT: "1", RVMP_HOOK_TOKEN: "probe",
        RVMP_CARD_ID: "0", RVMP_DISPATCH_ID: "doctor-probe",
      },
    });
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rvmp-doctor", version: "0" } },
    }) + "\n");
    await p.stdin.flush();
    const reader = p.stdout.getReader();
    const first = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value ?? new Uint8Array())),
      new Promise<null>((res) => setTimeout(() => res(null), 3000)),
    ]);
    p.kill();
    const ok = typeof first === "string" && first.includes('"serverInfo"');
    return { name, ok, detail: ok ? `${spec.command} ${spec.args.join(" ")}` : "initialize handshake failed — agents cannot report task_complete" };
  } catch {
    return { name, ok: false, detail: `cannot spawn: ${spec.command} ${spec.args.join(" ")}` };
  }
}

// ---------------------------------------------------------------------------
// task add — find the running daemon by probing the port range with the token
// ---------------------------------------------------------------------------

export async function findDaemon(opts?: { dataDir?: string; ports?: number[]; fetchFn?: typeof fetch }): Promise<{ base: string; token: string } | null> {
  const dataDir = opts?.dataDir ?? process.env.RVMP_DATA_DIR ?? join(homedir(), ".rvmp");
  const tokenPath = join(dataDir, "token");
  if (!existsSync(tokenPath)) return null;
  const token = readFileSync(tokenPath, "utf8").trim();
  const f = opts?.fetchFn ?? fetch;
  // The port file is written by OUR daemon (same-user data dir) — the token
  // is only presented there, never sprayed across a port range where any
  // local process could squat and harvest it (review A-C2).
  const portPath = join(dataDir, "port");
  const filePorts = existsSync(portPath) ? [Number(readFileSync(portPath, "utf8").trim())] : [];
  const ports = opts?.ports ?? filePorts;
  for (const port of ports) {
    if (!Number.isInteger(port) || port <= 0) continue;
    try {
      const res = await f(`http://127.0.0.1:${port}/api/projects`, {
        headers: { "x-rvmp-token": token },
        signal: AbortSignal.timeout(400),
      });
      if (res.ok) return { base: `http://127.0.0.1:${port}`, token };
    } catch { /* stale port file / daemon down */ }
  }
  return null;
}

export async function taskAdd(
  title: string,
  projectPath: string | null,
  opts?: Parameters<typeof findDaemon>[0],
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const daemon = await findDaemon(opts);
  if (!daemon) return { ok: false, message: "no running rvmp daemon found — start one with `rvmp`" };
  const H = { "x-rvmp-token": daemon.token, "content-type": "application/json" };
  const projects = (await (await fetch(`${daemon.base}/api/projects`, { headers: H })).json()) as Array<{ id: string; name: string; path: string }>;
  if (projects.length === 0) return { ok: false, message: "no projects yet — add one in the browser first" };
  const target = projectPath
    ? projects.find((p) => p.path === projectPath || p.path.replace(/\/+$/, "") === projectPath.replace(/\/+$/, ""))
    : projects.length === 1 ? projects[0] : null;
  if (!target) {
    return {
      ok: false,
      message: projectPath
        ? `no project registered at ${projectPath}`
        : `multiple projects — pick one with --project <path>:\n${projects.map((p) => `  ${p.path}`).join("\n")}`,
    };
  }
  const res = await fetch(`${daemon.base}/api/projects/${target.id}/cards`, {
    method: "POST", headers: H, body: JSON.stringify({ title }),
  });
  if (!res.ok) return { ok: false, message: `daemon rejected the card (${res.status})` };
  const card = (await res.json()) as { id: number };
  return { ok: true, message: `queued card #${card.id} in ${target.name}` };
}

// ---------------------------------------------------------------------------
// restore — offline, verified and rollback-safe
// ---------------------------------------------------------------------------

export async function restoreDatabase(
  backup: string,
  opts?: { dataDir?: string; daemonProbe?: () => Promise<unknown> },
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const dataDir = opts?.dataDir ?? process.env.RVMP_DATA_DIR ?? join(homedir(), ".rvmp");
  const running = await (opts?.daemonProbe ?? (() => findDaemon({ dataDir })))();
  if (running) return { ok: false, message: "rvmp daemon is running — stop it before restoring" };

  const source = isAbsolute(backup) || backup.includes(sep) || backup.startsWith(".")
    ? resolve(backup)
    : join(dataDir, "backups", backup);
  const dbPath = join(dataDir, "db.sqlite");
  if (!existsSync(source) || !statSync(source).isFile()) return { ok: false, message: `backup not found: ${source}` };
  if (resolve(source) === resolve(dbPath)) return { ok: false, message: "refusing to restore the live database over itself" };

  mkdirSync(dataDir, { recursive: true });
  const staged = join(dataDir, `.restore-${crypto.randomUUID()}.sqlite`);
  try {
    // Validate a private staged copy. SQLite databases using WAL mode may
    // need to create transient -shm state even for integrity_check; opening
    // the user's backup itself would therefore violate read-only validation.
    copyFileSync(source, staged);
    chmodSync(staged, 0o600);
  } catch (error) {
    rmSync(staged, { force: true });
    return { ok: false, message: `cannot stage backup: ${error instanceof Error ? error.message : String(error)}` };
  }

  let candidate: Database | null = null;
  let validationError: string | null = null;
  try {
    candidate = new Database(staged);
    const integrity = databaseIntegrity(candidate);
    if (!integrity.ok) validationError = `backup integrity check failed: ${integrity.detail}`;
    const required = candidate.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('_migrations','projects','cards')`,
    ).all() as Array<{ name: string }>;
    if (required.length !== 3) validationError = "backup is not an rvmp database";
  } catch (error) {
    validationError = `cannot read backup: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    candidate?.close();
  }
  rmSync(`${staged}-wal`, { force: true });
  rmSync(`${staged}-shm`, { force: true });
  if (validationError) {
    rmSync(staged, { force: true });
    return { ok: false, message: validationError };
  }

  let safety: string | null = null;
  if (existsSync(dbPath)) {
    const current = new Database(dbPath);
    try {
      safety = ensureDailyBackup(current, dbPath, new Date(), true);
    } finally {
      current.close();
    }
  }

  try {
    // Closing the current handle above checkpoints its WAL. Remove stale
    // sidecars before the atomic replacement so they can never replay over
    // the restored database on the next boot.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    renameSync(staged, dbPath);
  } catch (error) {
    rmSync(staged, { force: true });
    return { ok: false, message: `restore failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    ok: true,
    message: `restored ${source}${safety ? `; previous database backed up to ${safety}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "linux" ? ["xdg-open", url]
    : null;
  if (cmd) {
    try {
      Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
      return;
    } catch { /* fall through to printing */ }
  }
  console.log(`open ${url} in your browser`);
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv);
  switch (parsed.cmd) {
    case "version":
      console.log(pkg.version);
      return 0;
    case "help":
      console.log(HELP);
      return 0;
    case "error":
      console.error(parsed.message);
      return 2;
    case "doctor": {
      const rows = await doctorReport();
      for (const r of rows) console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(16)} ${r.detail}`);
      return rows.every((r) => r.ok) ? 0 : 1;
    }
    case "update":
      console.log("update rvmp:\n  npm i -g rvmp-cli@latest\n  # or re-run: curl -fsSL https://codegent.io/install | sh");
      return 0;
    case "restore": {
      const result = await restoreDatabase(parsed.backup);
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    case "mcp-sidecar":
      // Stdio MCP server for one agent dispatch; the import connects the
      // transport and the open stdin keeps the process alive until the agent
      // CLI closes it. Return the no-exit sentinel: calling process.exit here
      // would tear the server down the instant it connected.
      await import("./agents/mcp-entry");
      return -1;
    case "service": {
      const binPath = process.execPath;
      if (parsed.action === "enable" && !/rvmp(\.exe)?$/.test(binPath)) {
        // dev mode: execPath is bun itself — a unit running bare `bun start`
        // would KeepAlive-crash-loop (review A-Min). Services need the binary.
        console.error("service enable requires the installed rvmp binary (curl installer) — not a source run");
        return 1;
      }
      const result = parsed.action === "enable" ? await enableService(binPath)
        : parsed.action === "disable" ? await disableService()
        : await serviceStatus();
      console.log(`service: ${result}`);
      if (parsed.action === "enable") return result === "enabled" ? 0 : 1; // installer relies on this (A-Imp)
      return result === "unsupported" ? 1 : 0;
    }
    case "task-add": {
      const res = await taskAdd(parsed.title, parsed.project);
      console.log(res.message);
      return res.ok ? 0 : 1;
    }
    case "start": {
      // A daemon may already be running (service): REUSE it — a second boot
      // against the same db would mark its live dispatches interrupted (A-C1).
      const existing = await findDaemon();
      if (existing) {
        console.log(`rvmp daemon already running → ${existing.base}/#t=${existing.token}`);
        if (parsed.open) openBrowser(`${existing.base}/#t=${existing.token}`);
        return 0;
      }
      const { startDaemon } = await import("./daemon");
      const daemon = await startDaemon();
      if (parsed.open) openBrowser(`${daemon.url}#t=${daemon.token}`);
      return -1; // long-running — never exits here
    }
  }
}

if (import.meta.main) {
  void main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}
