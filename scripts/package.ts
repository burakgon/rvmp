#!/usr/bin/env bun
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Build the distributable layout for the CURRENT platform (spec §14):
//   dist/pkg/<platform-arch>/bin/codegent      (compiled daemon+CLI)
//   dist/pkg/<platform-arch>/share/web/**      (built UI, found via resolveWebDist)
// Cross-compilation is a release-time concern (bun build --target per triple);
// this script stays single-target so CI/laptops produce their own artifact.
// Usage: bun scripts/package.ts [--skip-web]

const root = join(import.meta.dir, "..");
const target = `${process.platform}-${process.arch}`;
const out = join(root, "dist", "pkg", target);

const run = async (cwd: string, cmd: string[]): Promise<void> => {
  const p = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
};

if (!process.argv.includes("--skip-web")) {
  await run(join(root, "apps", "web"), ["bunx", "vite", "build"]);
}
const webDist = join(root, "apps", "web", "dist");
if (!existsSync(webDist)) throw new Error("apps/web/dist missing — build the web UI first");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });
await run(root, [
  "bun", "build", "--compile",
  join(root, "apps", "daemon", "src", "cli.ts"),
  "--outfile", join(out, "bin", "codegent"),
]);
cpSync(webDist, join(out, "share", "web"), { recursive: true });

console.log(`packaged → ${out}`);
console.log(`  bin/codegent  (run: ${join(out, "bin", "codegent")} --version)`);
console.log(`  share/web     (${target})`);
