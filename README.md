# codegent

Browser-based AI coding-agent orchestrator. Pre-release — v0.1 core.

## Develop

Needs [Bun](https://bun.sh) ≥ 1.3.14. One-time setup first: the terminal
renderer (`vendor/ghostty-web`) is a git submodule whose wasm + dist are
built from source, which needs Zig 0.15.2 (exact) on PATH — the build pulls
its own ~206MB ghostty checkout on first run. Build it *before* the root
`bun install` (install copies the built package into node_modules); details
and troubleshooting in `docs/research/ghostty-web-spike.md`.

```sh
git submodule update --init
(cd vendor/ghostty-web && bun install && bun run build)
```

Then:

```sh
bun install
bun run dev:daemon   # prints http://127.0.0.1:4666/?t=<token>
bun run dev:web      # http://localhost:5666 — open it with ?t=<token>
```

Tests: `bun test` · License: AGPL-3.0
