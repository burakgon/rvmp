import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// User-level service management (spec §14): launchd on macOS, systemd --user
// on Linux (WSL included when systemd is enabled). Everything shells through
// an injectable runner so tests assert the exact call sequences without
// touching the host.

export type ServiceRunner = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execRunner: ServiceRunner = async (cmd) => {
  try {
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } catch {
    return { code: 127, stdout: "", stderr: "spawn failed" };
  }
};

export type ServiceStatus = "enabled" | "disabled" | "unsupported";

const LAUNCHD_LABEL = "io.codegent.daemon";

export function launchdPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home = homedir()): string {
  return join(home, ".config", "systemd", "user", "codegent.service");
}

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Agent CLIs live in user-installed prefixes launchd/systemd never provide —
 * bake a sane PATH into the unit (review A-Imp: probes/spawns failed under
 * the service's bare environment). */
export function servicePath(home = homedir()): string {
  return [join(home, ".codegent", "bin"), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

/** Deterministic launchd plist: RunAtLoad + KeepAlive, logs under ~/.codegent/logs. */
export function launchdPlist(binPath: string, home = homedir()): string {
  const logDir = join(home, ".codegent", "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binPath)}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(servicePath(home))}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logDir, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

/** Deterministic systemd --user unit (path quoted — spaces survive). */
export function systemdUnit(binPath: string, home = homedir()): string {
  return `[Unit]
Description=codegent daemon

[Service]
ExecStart="${binPath}" start --no-open
Environment=PATH=${servicePath(home)}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

export interface ServiceDeps {
  run?: ServiceRunner;
  platform?: NodeJS.Platform;
  home?: string;
}

const deps = (d?: ServiceDeps) => ({
  run: d?.run ?? execRunner,
  platform: d?.platform ?? process.platform,
  home: d?.home ?? homedir(),
});

/** Install + start the user service for `binPath`. Idempotent. */
export async function enableService(binPath: string, d?: ServiceDeps): Promise<ServiceStatus> {
  const { run, platform, home } = deps(d);
  mkdirSync(join(home, ".codegent", "logs"), { recursive: true });
  if (platform === "darwin") {
    const plist = launchdPlistPath(home);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, launchdPlist(binPath, home));
    await run(["launchctl", "unload", plist]); // idempotent re-enable: reload cleanly
    const load = await run(["launchctl", "load", plist]);
    return load.code === 0 ? "enabled" : "disabled";
  }
  if (platform === "linux") {
    const unit = systemdUnitPath(home);
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    // Restart is needed ONLY when an old daemon is already running (binary
    // swap); on first enable it would double-start and boot-reconcile the
    // fresh daemon's dispatches (verify [medium]).
    const wasActive = (await run(["systemctl", "--user", "is-active", "codegent.service"])).code === 0;
    writeFileSync(unit, systemdUnit(binPath, home));
    const reload = await run(["systemctl", "--user", "daemon-reload"]);
    const en = await run(["systemctl", "--user", "enable", "--now", "codegent.service"]);
    const restart = wasActive ? await run(["systemctl", "--user", "restart", "codegent.service"]) : { code: 0 };
    return reload.code === 0 && en.code === 0 && restart.code === 0 ? "enabled" : "disabled";
  }
  return "unsupported";
}

/** Stop + remove the user service. Idempotent — absent service is a no-op. */
export async function disableService(d?: ServiceDeps): Promise<ServiceStatus> {
  const { run, platform, home } = deps(d);
  if (platform === "darwin") {
    const plist = launchdPlistPath(home);
    if (existsSync(plist)) {
      await run(["launchctl", "unload", plist]);
      rmSync(plist, { force: true });
    }
    return "disabled";
  }
  if (platform === "linux") {
    const unit = systemdUnitPath(home);
    if (existsSync(unit)) {
      await run(["systemctl", "--user", "disable", "--now", "codegent.service"]);
      rmSync(unit, { force: true });
      await run(["systemctl", "--user", "daemon-reload"]);
    }
    return "disabled";
  }
  return "unsupported";
}

export async function serviceStatus(d?: ServiceDeps): Promise<ServiceStatus> {
  const { run, platform, home } = deps(d);
  if (platform === "darwin") {
    if (!existsSync(launchdPlistPath(home))) return "disabled";
    const res = await run(["launchctl", "list", LAUNCHD_LABEL]);
    return res.code === 0 ? "enabled" : "disabled";
  }
  if (platform === "linux") {
    if (!existsSync(systemdUnitPath(home))) return "disabled";
    const res = await run(["systemctl", "--user", "is-enabled", "codegent.service"]);
    return res.code === 0 ? "enabled" : "disabled";
  }
  return "unsupported";
}
