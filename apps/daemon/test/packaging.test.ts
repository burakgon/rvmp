import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebDist } from "../src/http/server";

// T3 packaging seams. The full compile smoke lives in scripts/package.ts
// (exercised at release time + the project-end live pass) — tests here lock
// the pure resolution logic every packaged binary depends on.

describe("resolveWebDist", () => {
  test("env override wins unconditionally", () => {
    process.env.CODEGENT_WEB_DIST = "/custom/web";
    try {
      expect(resolveWebDist("/whatever/bin/codegent")).toBe("/custom/web");
    } finally {
      delete process.env.CODEGENT_WEB_DIST;
    }
  });
  test("packaged layout: share/web beside the binary wins when it exists", () => {
    const pkg = mkdtempSync(join(tmpdir(), "cg-pkg-"));
    mkdirSync(join(pkg, "share", "web"), { recursive: true });
    mkdirSync(join(pkg, "bin"), { recursive: true });
    expect(resolveWebDist(join(pkg, "bin", "codegent"))).toBe(join(pkg, "bin", "..", "..", "share", "web"));
    rmSync(pkg, { recursive: true, force: true });
  });
  test("dev fallback: monorepo web/dist path derived from the source dir", () => {
    const got = resolveWebDist("/nonexistent/bin/codegent", "/repo/apps/daemon/src/http");
    expect(got).toBe("/repo/apps/daemon/src/http/../../../web/dist");
  });
});

describe("install.sh", () => {
  const sh = (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawnSync({
      cmd: ["sh", join(import.meta.dir, "../../../scripts/install.sh"), ...args],
      env: { ...process.env, ...env },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  test("dry-run prints the full plan without touching the system", () => {
    const r = sh(["--dry-run"], { CODEGENT_DOWNLOAD_BASE: "https://example.test/rel" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://example.test/rel/codegent-");
    expect(r.out).toContain(".codegent/bin");
    expect(r.out).toContain("codegent service enable");
  });
  test("--no-service is honored; unknown flags reject", () => {
    expect(sh(["--dry-run", "--no-service"]).out).toContain("skipped (--no-service)");
    expect(sh(["--bogus"]).code).toBe(2);
  });
});
