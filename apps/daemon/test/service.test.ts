import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disableService, enableService, launchdPlist, launchdPlistPath,
  serviceStatus, systemdUnit, systemdUnitPath, type ServiceRunner,
} from "../src/service";

const scripted = (fail: string[] = []) => {
  const calls: string[][] = [];
  const run: ServiceRunner = async (cmd) => {
    calls.push(cmd);
    return { code: fail.some((f) => cmd.join(" ").includes(f)) ? 1 : 0, stdout: "", stderr: "" };
  };
  return { calls, run };
};

describe("unit file generation", () => {
  test("launchd plist carries label, start --no-open, KeepAlive, log paths", () => {
    const p = launchdPlist("/opt/codegent/bin/codegent", "/home/u");
    expect(p).toContain("<string>io.codegent.daemon</string>");
    expect(p).toContain("<string>/opt/codegent/bin/codegent</string>");
    expect(p).toContain("<string>--no-open</string>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("/home/u/.codegent/logs/daemon.log");
  });
  test("systemd unit restarts on failure and wants default.target", () => {
    const u = systemdUnit("/usr/local/bin/codegent");
    expect(u).toContain('ExecStart="/usr/local/bin/codegent" start --no-open'); // quoted: spaces survive
    expect(u).toContain("Environment=PATH="); // agent CLIs need a real PATH under systemd
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
  });
});

describe("enable/disable/status per platform", () => {
  test("darwin: enable writes the plist and (re)loads; status via launchctl list; disable unloads + removes", async () => {
    const home = mkdtempSync(join(tmpdir(), "cg-svc-"));
    const s = scripted();
    expect(await enableService("/bin/cg", { run: s.run, platform: "darwin", home })).toBe("enabled");
    expect(existsSync(launchdPlistPath(home))).toBe(true);
    expect(readFileSync(launchdPlistPath(home), "utf8")).toContain("/bin/cg");
    expect(s.calls.map((c) => c[0] + " " + c[1])).toEqual(["launchctl unload", "launchctl load"]);

    expect(await serviceStatus({ run: s.run, platform: "darwin", home })).toBe("enabled");

    expect(await disableService({ run: s.run, platform: "darwin", home })).toBe("disabled");
    expect(existsSync(launchdPlistPath(home))).toBe(false);
    // disabled with no plist present → status short-circuits, no launchctl call
    const s2 = scripted();
    expect(await serviceStatus({ run: s2.run, platform: "darwin", home })).toBe("disabled");
    expect(s2.calls.length).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test("linux: enable writes the unit + daemon-reload + enable --now; disable removes and reloads", async () => {
    const home = mkdtempSync(join(tmpdir(), "cg-svc-"));
    const s = scripted(["is-active"]); // fresh machine: no unit is active yet
    expect(await enableService("/bin/cg", { run: s.run, platform: "linux", home })).toBe("enabled");
    expect(readFileSync(systemdUnitPath(home), "utf8")).toContain('ExecStart="/bin/cg" start --no-open');
    expect(s.calls).toEqual([
      ["systemctl", "--user", "is-active", "codegent.service"], // restart ONLY when an old daemon runs
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "codegent.service"],
    ]);
    // Re-enable over a RUNNING daemon adds the binary-swapping restart.
    const live = scripted(); // is-active exits 0 in the stub → treated active
    await enableService("/bin/cg2", { run: live.run, platform: "linux", home });
    expect(live.calls.at(-1)).toEqual(["systemctl", "--user", "restart", "codegent.service"]);
    expect(await disableService({ run: s.run, platform: "linux", home })).toBe("disabled");
    expect(existsSync(systemdUnitPath(home))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("failure and unsupported degrade honestly", async () => {
    const home = mkdtempSync(join(tmpdir(), "cg-svc-"));
    const failing = scripted(["launchctl load"]);
    expect(await enableService("/bin/cg", { run: failing.run, platform: "darwin", home })).toBe("disabled");
    expect(await enableService("/bin/cg", { run: scripted().run, platform: "win32", home })).toBe("unsupported");
    expect(await serviceStatus({ run: scripted().run, platform: "win32", home })).toBe("unsupported");
    rmSync(home, { recursive: true, force: true });
  });
});
