# Contributing

- `bun install` → `bun test` (all green) → `bun run typecheck` (exit 0) before any PR.
- Web changes must also pass `cd apps/web && bunx vite build`.
- Product principle 1 is non-negotiable: terminal content never leaves the
  terminal — surfaces show state + elapsed time only.
- Plain conventional commits. By opening a PR you accept [CLA.md](CLA.md).
- New agent support belongs in the universal tier (detection manifests) —
  see `apps/daemon/src/detect/manifests/`.
