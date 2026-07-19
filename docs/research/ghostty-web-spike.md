# ghostty-web spike findings (Task 3 — HARD GATE)

Date: 2026-07-19 · Machine: Apple Silicon (arm64), macOS 27.0 beta (Darwin 27.0.0, build 26A5378n) · Bun 1.3.14

**Gate verdict: PASS (all three criteria, automated), with one upstream bug found + verified workaround, and one manual check pending (real IME).**

## 1. Pinned versions

| What | Value |
| --- | --- |
| ghostty-web (submodule `vendor/ghostty-web`) | `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab` (origin/main, 2026-06-28, "ci: fix release please notes setup (#183)", package version 0.4.0) |
| ghostty (nested submodule `vendor/ghostty-web/ghostty`) | `5714ed07a1012573261b7b7e3ed2add9c1504496` (pinned by ghostty-web) |
| Zig | 0.15.2 (exact — ghostty's `build.zig` rejects any other major.minor; ghostty-web CI pins the same via `.github/actions/setup-zig`) |
| Bun | 1.3.14 |

The pinned SHA builds green — no walk-back was needed. (One environment-level fix was required on macOS 27 beta, see §2.2; it is host-SDK-related, not SHA-related.)

## 2. Building from source

### 2.1 Canonical steps (per ghostty-web's README/CI)

```bash
git submodule update --init --recursive          # pulls the ~206MB ghostty checkout
# install Zig 0.15.2 exactly (ziglang.org tarball, as upstream CI does):
curl -fsSLO https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz
cd vendor/ghostty-web
bun install
bun run build     # = clean + build:wasm (scripts/build-wasm.sh) + vite build + copy wasm into dist/
```

`build-wasm.sh` applies `patches/ghostty-wasm-api.patch` to the ghostty checkout, runs
`zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`, copies
`ghostty/zig-out/bin/ghostty-vt.wasm` to the package root, then reverts the patch (submodule stays clean).

Outputs (gitignored inside the submodule — every checkout must rebuild before `bun install` at the repo root):

- `ghostty-vt.wasm` (416 KB)
- `dist/ghostty-web.js` (ESM, 702 KB), `dist/ghostty-web.umd.cjs`, `dist/index.d.ts`, `dist/ghostty-vt.wasm`

### 2.2 macOS 27 (beta) SDK gotcha — required on this machine

Zig 0.15.2 cannot link ANY host binary (including the zig build runner itself) against the macOS 26.5/27
Command Line Tools SDKs: their `libSystem.tbd` stubs only declare `arm64e-macos` targets (no plain
`arm64-macos`), so every libc symbol resolves as undefined (`_fork`, `_getcwd`, `_sigaction`, ...).
Zig 0.16 tolerates this but is rejected by ghostty's exact-version check — and hiding the SDK entirely
makes ghostty's `pkg/apple-sdk` fail with `DarwinSdkNotFound` (its zlib build-time dependency calls
`std.zig.LibCInstallation.findNative`, which shells out to `xcode-select` + `xcrun`).

Fix used (documented so it can be reproduced or retired once the OS/toolchain settle):

1. Hybrid SDK at `~/.cache/codegent-toolchain/fake-macos-sdk/`:
   - `usr/include` → symlink to the real `MacOSX26.5.sdk/usr/include`
   - `System/Library/Frameworks` → symlink to the real SDK's frameworks
   - `usr/lib/libSystem.tbd` → **copy of Zig's own bundled stub** (`<zig>/lib/libc/darwin/libSystem.tbd`, which has `arm64-macos` targets)
   - `SDKSettings.json` → copy of Zig's bundled one
2. Shim dir first on `PATH` (`~/.cache/codegent-toolchain/sdk-shim/`): `xcode-select` prints the CLT path;
   `xcrun` answers `--show-sdk-path` with the hybrid SDK path and delegates everything else to `/usr/bin/xcrun`.

```bash
export PATH="$HOME/.cache/codegent-toolchain/sdk-shim:$HOME/.cache/codegent-toolchain/zig-0.15.2:$PATH"
cd vendor/ghostty-web && bun run build   # exit 0
```

On a released macOS with a normal SDK (or once ghostty moves to a Zig that understands arm64e-only stubs)
none of this should be needed — try the canonical steps first.

### 2.3 Wiring into apps/web

- `apps/web/package.json`: `"ghostty-web": "file:../../vendor/ghostty-web"` → `bun install` at repo root.
  Bun copies the package into `node_modules/.bun/ghostty-web@file+...` (content-hashed) and symlinks
  `apps/web/node_modules/ghostty-web` to it. Caveats:
  - Bun ignores the `files` allowlist for `file:` deps → the copy includes the 206MB ghostty checkout (~209MB total). Wasteful but functional; revisit later (e.g. publishable subdir or `.npmignore` upstream).
  - **OWNER-FLAGGED — upstream `@xterm/*` devDependencies get installed.** For `file:` deps bun also resolves
    and installs the linked package's **devDependencies**, which for ghostty-web include `@xterm/xterm` +
    `@xterm/headless` 5.5.0 (upstream uses them solely for its own benchmarks). They therefore appear in
    `bun.lock` and `node_modules/.bun/` — a literal breach of the project's "no xterm.js anywhere" constraint,
    accepted for now pending owner decision. No first-party code imports them and nothing xterm-related ships
    in our bundle; covering check (expected zero hits):
    `grep -rn "@xterm" apps packages --include=*.ts --include=*.tsx --include=*.json | grep -v node_modules`.
    In the Task 13 era, investigate suppressing linked-package devDep installation — e.g. consume a packed
    tarball of the built dist instead of `file:`-linking the source tree, or point the dependency at a pruned
    manifest copy (package.json with devDependencies stripped).
  - Build vendor **before** `bun install`, else the copy lacks `dist/` (content hash changes after a rebuild, so a later `bun install` refreshes it).
- Root `package.json` test script became `bun test --pass-with-no-tests apps packages`: a bare `bun test` from
  the repo root would recurse into `vendor/ghostty-web/lib/*.test.ts`, which need the submodule's own happy-dom
  preload (`bunfig.toml`) and fail with `document is not defined` outside it. Run the vendor suite from inside
  `vendor/ghostty-web` (`bun test` → 372 pass / 0 fail against the locally built WASM — good build validation).
- `apps/web/vite.config.ts`: `optimizeDeps: { exclude: ["ghostty-web"] }` is **required**. The library locates
  its WASM via `new URL('../ghostty-vt.wasm', import.meta.url)`; Vite pre-bundling would relocate the module
  to `.vite/deps` and break that relative URL (the fetch fallbacks then grab the SPA fallback HTML and
  `WebAssembly.compile` fails confusingly).

## 3. Real API surface (what Task 13's `GhosttyTerm.tsx` will use)

```ts
import { init, Terminal } from "ghostty-web";     // also: FitAddon, Ghostty, CanvasRenderer, ...
await init();                                     // REQUIRED once per page before any `new Terminal`
                                                  // (loads ghostty-vt.wasm; shared instance for all terminals)
const t = new Terminal({ cols: 80, rows: 24 });   // ITerminalOptions: cols, rows, fontSize (15), fontFamily
                                                  //   ('monospace'), theme (ITheme), scrollback (see caveat 3!),
                                                  //   convertEol, cursorBlink, ...
t.open(el);                                       // appends <canvas> + hidden <textarea> into el; write() before open() throws
t.write(data, cb?);                               // string | Uint8Array; SYNCHRONOUS parse into WASM (no internal
                                                  //   queue like xterm.js); cb fires on the next rAF after processing
t.onData((s) => pty.write(s));                    // user input (also: onResize, onBell, onTitleChange, onKey,
                                                  //   onScroll, onRender, onSelectionChange, IEvent<T> disposables)
t.resize(cols, rows);                             // no-ops if size unchanged
t.dispose();                                      // frees the WASM terminal + DOM; see caveat 1
// Read-back (xterm-compatible): t.buffer.active.length / .getLine(y).translateToString(true)
//   / .getLine(y).getCell(x).{getChars,getFgColor,isBold,...}   — getFgColorMode() is always -1 (RGB resolved)
// Extras: t.clear(), t.reset() (≈ dispose+create, see caveat 1!), t.focus(), t.loadAddon(new FitAddon()),
//   t.getScrollbackLength(), t.getScrollbackLine(offset), t.hasSelection(), selection APIs, link providers
```

### API caveats discovered (all reproduced deterministically)

1. **Stale-memory leak on create-after-dispose (upstream bug).** The WASM allocator recycles freed terminal
   memory without clearing it: a fresh `Terminal` (same geometry) starts with the disposed terminal's screen
   content (cursor at 0,0 over the old glyphs); with different geometry the stale cells are reinterpreted as
   garbage glyphs. `Terminal.reset()` does NOT help — it is literally free+create, which recycles again.
   **Workaround (verified):** write `"\x1b[H\x1b[2J\x1b[3J"` immediately after `open()` on every new terminal;
   buffer is then pristine. `GhosttyTerm` must do this unconditionally. Upstream fix would be zeroing screen
   pages in `ghostty_terminal_new` (patch's `src/terminal/c/terminal.zig`) — file an issue with the
   `recycle` phase of the spike as repro.
2. **`write("")` throws** `RangeError: offset is out of bounds` (`ghostty_wasm_alloc_u8_array(0)` returns a bad
   pointer, then `Uint8Array.set`). Real PTY chunks are never empty, but the wrapper must guard
   `if (data.length === 0) return cb?.()` — don't use empty writes as render fences.
3. **`scrollback` option is ignored.** Effective scrollback is a fixed WASM page budget: ~621 lines at 80 cols,
   ~385 lines at 120 cols in these tests, regardless of `scrollback: 100/5000/10000`. Consequence for codegent:
   the server-side 200KB ring is the real history; client scrollback depth must not be relied upon.
4. Hidden input textareas lack `id`/`name` (Chrome a11y issue "form field should have an id or name") — cosmetic,
   note for Task 13.

## 4. Gate results (automated, Chrome via CDP, Vite dev server)

Spike page: `apps/web/spike/ghostty.html` + `ghostty-spike.ts` (run `bunx vite` in `apps/web`, open
`/spike/ghostty.html`; results land in `window.__spikeResults`, evidence screenshot in
`apps/web/spike/spike-evidence.png` — generated locally, kept untracked).

| Criterion | Result | Numbers |
| --- | --- | --- |
| (a) Soak: 20 cycles × 4 panes create/destroy | **PASS** | 80/80 panes created AND buffer-verified (own colored banner readable pre-dispose), 0 failures, 0 page errors, 632–701ms total; JS heap 25→17MB (run 1) / 25→37MB (run 2) — GC noise, no blowup |
| (b) Throughput: 5 MiB into one 120×40 terminal | **PASS** | 5,242,920 bytes / 43,691 line-writes in **162–167ms** sync (~30 MiB/s), end marker rendered by 169–172ms — ~60× under the 10s bar |
| (c) Replay: 202,000-byte / 2,000-line colored ring → dispose → fresh terminal → re-feed | **PASS** | all 40 viewport lines byte-identical (before vs after); last line `replay line 1999 ... OK!`; color probe identical AND non-default: 'O' fg=0xB5BD68 (theme green, SGR 32), '!' fg=0xB294BB (theme magenta, bold, SGR 1;35), default fg=0xCCCCCC; screenshot confirms colors on canvas |
| (e) Recycle probe (extra) | PASS (workaround) | leak reproduced (`leakDetected=true`), ANSI-clear workaround verified (`workaroundClears=true`), `reset()` confirmed not a fix |

### IME status — partially verified, manual check pending

Synthetic `CompositionEvent` sequence (compositionstart → ㅎ/하/한 updates → compositionend "한") against the
terminal's textarea: exactly **one** commit `"한"` arrived via `onData` (no duplicates), and echoing it back
renders the Hangul glyph in the buffer and on canvas. This exercises ghostty-web's composition-event path only —
**a real macOS Korean 2-Set IME drives its own event stream and remains a MANUAL pending check** (OS-level IME
cannot be automated from the browser). Note: `lib/input-handler.ts` carries a stale header comment claiming IME
is "to be added later", but full composition handlers exist and work.

### What was verified automatically vs needs human eyes

- Automated: all buffer-level content/attribute checks above, canvas screenshots reviewed in-session
  (colors visibly correct in the generated `spike-evidence.png`; the image itself stays out of the repo).
- Human glance still valuable: sustained interactive feel (scrolling/selection under churn), real IME (above),
  pixel-level font rendering taste.

## 5. Go/no-go

**GO.** All three hard-gate criteria pass with wide margins on a from-source build of the pinned SHA.
Ship Task 13's `GhosttyTerm` with: mandatory `await init()` gate, post-`open()` ANSI sanitize
(`\x1b[H\x1b[2J\x1b[3J`), empty-chunk guard, no reliance on client scrollback, and an upstream issue filed for
caveat 1 (spec's fix-upstream path; owner sign-off needed on timeline only if we want the sanitize removed).
