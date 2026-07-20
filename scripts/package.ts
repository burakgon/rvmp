#!/usr/bin/env bun
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Build the distributable layout for the CURRENT platform (spec §14):
//   dist/pkg/<platform-arch>/bin/codegent      (compiled daemon+CLI)
//   dist/pkg/<platform-arch>/share/web/**      (built UI, found via resolveWebDist)
// Usage: bun scripts/package.ts [--skip-web] [--target <plat-arch>|all]
// Targets map to bun's cross-compile triples; `all` builds every release
// target and a .tar.gz per target under dist/release/.

const root = join(import.meta.dir, "..");
const TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
};
const argTarget = ((): string[] => {
  const i = process.argv.indexOf("--target");
  if (i < 0) return [`${process.platform}-${process.arch}`];
  const v = process.argv[i + 1];
  if (v === "all") return Object.keys(TARGETS);
  if (!v || !TARGETS[v]) throw new Error(`--target must be one of: ${Object.keys(TARGETS).join(", ")}, all`);
  return [v];
})();

const run = async (cwd: string, cmd: string[]): Promise<void> => {
  const p = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
};

if (!process.argv.includes("--skip-web")) {
  await run(join(root, "apps", "web"), ["bunx", "vite", "build"]);
}
const webDist = join(root, "apps", "web", "dist");
if (!existsSync(webDist)) throw new Error("apps/web/dist missing — build the web UI first");

for (const target of argTarget) {
  const out = join(root, "dist", "pkg", target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "bin"), { recursive: true });
  await run(root, [
    "bun", "build", "--compile", `--target=${TARGETS[target]}`,
    join(root, "apps", "daemon", "src", "cli.ts"),
    "--outfile", join(out, "bin", "codegent"),
  ]);
  cpSync(webDist, join(out, "share", "web"), { recursive: true });
  // Release tarball: extracts to bin/ + share/ (install.sh expects this layout).
  mkdirSync(join(root, "dist", "release"), { recursive: true });
  const tarball = join(root, "dist", "release", `codegent-${target}.tar.gz`);
  await run(out, ["tar", "-czf", tarball, "bin", "share"]);
  console.log(`packaged → ${target}  (${tarball})`);
}
