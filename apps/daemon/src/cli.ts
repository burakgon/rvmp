#!/usr/bin/env bun
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { AGENT_REGISTRY } from "./detect/agent-registry";
import { disableService, enableService, serviceStatus, type ServiceDeps } from "./service";

// The `codegent` command (spec §14, local-only): start (+open), doctor,
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
  | { cmd: "update" }
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
  if (head === "service") {
    const action = rest[0];
    if (action === "enable" || action === "disable" || action === "status") return { cmd: "service", action };
    return { cmd: "error", message: "usage: codegent service enable|disable|status" };
  }
  if (head === "task") {
    if (rest[0] !== "add" || !rest[1]) return { cmd: "error", message: 'usage: codegent task add "<title>" [--project <path>]' };
    const pi = rest.indexOf("--project");
    return { cmd: "task-add", title: rest[1], project: pi >= 0 ? rest[pi + 1] ?? null : null };
  }
  return { cmd: "error", message: `unknown command '${head}' — try: codegent help` };
}

export const HELP = `codegent ${pkg.version} — local coding-agent orchestrator

  codegent [start]            start the daemon and open the board (--no-open)
  codegent doctor             environment checks (git, agents, port, service)
  codegent task add "<t>"     add a card to the running daemon [--project <path>]
  codegent service <action>   enable | disable | status (launchd / systemd --user)
  codegent update             how to update
  codegent --version
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

  const dataDir = process.env.CODEGENT_DATA_DIR ?? join(home, ".codegent");
  let writable = true;
  try {
    if (existsSync(dataDir)) accessSync(dataDir, constants.W_OK);
  } catch {
    writable = false;
  }
  rows.push({ name: "data dir", ok: writable, detail: `${dataDir}${writable ? "" : " — not writable"}` });

  rows.push({ name: "service", ok: true, detail: await serviceStatus(d?.service) });
  return rows;
}

// ---------------------------------------------------------------------------
// task add — find the running daemon by probing the port range with the token
// ---------------------------------------------------------------------------

export async function findDaemon(opts?: { dataDir?: string; ports?: number[]; fetchFn?: typeof fetch }): Promise<{ base: string; token: string } | null> {
  const dataDir = opts?.dataDir ?? process.env.CODEGENT_DATA_DIR ?? join(homedir(), ".codegent");
  const tokenPath = join(dataDir, "token");
  if (!existsSync(tokenPath)) return null;
  const token = readFileSync(tokenPath, "utf8").trim();
  const f = opts?.fetchFn ?? fetch;
  const ports = opts?.ports ?? Array.from({ length: PORT_MAX - PORT_BASE }, (_, i) => PORT_BASE + i);
  for (const port of ports) {
    try {
      const res = await f(`http://127.0.0.1:${port}/api/projects`, {
        headers: { "x-codegent-token": token },
        signal: AbortSignal.timeout(400),
      });
      if (res.ok) return { base: `http://127.0.0.1:${port}`, token };
    } catch { /* nothing on this port */ }
  }
  return null;
}

export async function taskAdd(
  title: string,
  projectPath: string | null,
  opts?: Parameters<typeof findDaemon>[0],
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const daemon = await findDaemon(opts);
  if (!daemon) return { ok: false, message: "no running codegent daemon found — start one with `codegent`" };
  const H = { "x-codegent-token": daemon.token, "content-type": "application/json" };
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
      console.log("update codegent:\n  npm i -g codegent-cli@latest\n  # or re-run: curl -fsSL https://codegent.io/install | sh");
      return 0;
    case "service": {
      const binPath = process.execPath; // the compiled binary (or bun in dev)
      const result = parsed.action === "enable" ? await enableService(binPath)
        : parsed.action === "disable" ? await disableService()
        : await serviceStatus();
      console.log(`service: ${result}`);
      return result === "unsupported" ? 1 : 0;
    }
    case "task-add": {
      const res = await taskAdd(parsed.title, parsed.project);
      console.log(res.message);
      return res.ok ? 0 : 1;
    }
    case "start": {
      const { startDaemon } = await import("./daemon");
      const daemon = await startDaemon();
      if (parsed.open) openBrowser(`${daemon.url}?t=${daemon.token}`);
      return -1; // long-running — never exits here
    }
  }
}

if (import.meta.main) {
  void main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}
