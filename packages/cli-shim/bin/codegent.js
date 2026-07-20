#!/usr/bin/env node
// codegent-cli launcher (spec §14 front door): `npx codegent-cli` must work
// with zero commitment. Resolution order:
//   1. CODEGENT_BIN override
//   2. the installed binary at ~/.codegent/bin/codegent
//   3. a local `bun` + monorepo checkout (developer convenience)
//   4. print the curl installer one-liner (release binaries carry the daemon;
//      this shim stays tiny and never bundles a runtime).
"use strict";
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const args = process.argv.slice(2);
const candidates = [];
if (process.env.CODEGENT_BIN) candidates.push(process.env.CODEGENT_BIN);
candidates.push(join(os.homedir(), ".codegent", "bin", "codegent"));

for (const bin of candidates) {
  if (bin && existsSync(bin)) {
    const r = spawnSync(bin, args, { stdio: "inherit" });
    process.exit(r.status === null ? 1 : r.status);
  }
}

// Developer path: running from a checkout with bun available.
const cliTs = join(__dirname, "..", "..", "..", "apps", "daemon", "src", "cli.ts");
const bunOk = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
if (bunOk && existsSync(cliTs)) {
  const r = spawnSync("bun", [cliTs, ...args], { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}

console.error(
  "codegent binary not found.\n" +
  "Install it with:\n\n  curl -fsSL https://codegent.io/install | sh\n\n" +
  "(or set CODEGENT_BIN to an existing codegent binary)"
);
process.exit(1);
