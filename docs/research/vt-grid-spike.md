# Server-side VT grid spike findings (Plan 3 Part 1, Task 1 — HARD GATE)

Date: 2026-07-20 · Machine: Apple M4 Pro (arm64), macOS 27.0 build 26A5378n · Bun 1.3.14

**Gate verdict: PASS-ghostty.** The daemon can drive the already-vendored ghostty-vt WASM core without a
DOM, read the rendered active viewport as cells, turn its bottom rows into strings, and retain OSC 0/2/9
metadata beside it. Tasks 4/6 can use one stateful reader per PTY session; xterm.js is not involved.

## 1. Scope and pinned input

| Item | Value |
| --- | --- |
| `vendor/ghostty-web` | `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab` (`v0.4.0-20-g1858a59`, package 0.4.0, MIT) |
| `ghostty-vt.wasm` | 423,939 bytes; SHA-256 `794191ccd9f469ed0d49ebcb3e6b326d64279b91752b71ad80a3d89ff1f26416` |
| Required output | rendered bottom N active-viewport rows + retained OSC 0/2 title + retained OSC 9 progress |
| Explicit exclusion | `@xterm/headless`, xterm.js, a DOM, or a browser in the daemon |

The architectural reference is Herdr: it owns a server-side libghostty-vt screen and classifies the bottom
viewport rows while retaining OSC metadata separately. Orca's server-side screen is
`@xterm/headless` + SerializeAddon; that implementation is useful prior art but is banned here.

## 2. Path A — vendored ghostty, headless in Bun

### 2.1 The high-level `Terminal` is not the headless API

This probe imported the built package entry, called `await init()`, constructed a `Terminal`, inspected its
documented buffer surface, called `write()`, and then tried `open()` with a minimal parent stub. It ran in
plain Bun, not happy-dom:

```ts
import { init, Terminal } from "./vendor/ghostty-web/dist/ghostty-web.js";

console.log({ document: typeof document, OffscreenCanvas: typeof OffscreenCanvas });
await init();
const term = new Terminal({ cols: 20, rows: 5 });
console.log({
  length: term.buffer.active.length,
  line0: term.buffer.active.getLine(0),
  serialize: typeof (term as unknown as { serialize?: unknown }).serialize,
  wasmTerm: typeof term.wasmTerm,
});
term.write("\x1b[2J\x1b[HOpenAI Codex\r\n> ");
```

Observed API truth before `open()`:

```text
globals {"document":"undefined","OffscreenCanvas":"undefined"}
pre-open {"length":0,"serialize":"undefined","wasmTerm":"undefined"}
write-no-open Error: Terminal must be opened before use. Call terminal.open(parent) first.
```

The buffer namespace exists, but `active.length` is zero and `getLine(0)` is `undefined` because
`Terminal.open()` is what creates its `wasmTerm`. There is no `serialize()` method. A parent object with the
element methods needed for cleanup reached the renderer setup and failed verbatim with:

```text
Error: Failed to open terminal: ReferenceError: document is not defined
```

`OffscreenCanvas` is also absent in this Bun runtime. Supplying one would not remove the rest of
`Terminal.open()`'s DOM/input/renderer requirements. Therefore `init() → new Terminal() → buffer` is not a
daemon path, and a fake DOM would be avoidable production machinery.

### 2.2 The exported advanced WASM wrapper is the working headless API

ghostty-web publicly exports `Ghostty` and `GhosttyTerminal` for advanced integrations. Unlike the browser
`Terminal`, this layer creates the VT state directly and has no renderer, canvas, input handler, or DOM
dependency:

```ts
import { Ghostty } from "./vendor/ghostty-web/lib/ghostty";

const ghostty = await Ghostty.load("./vendor/ghostty-web/ghostty-vt.wasm");
const terminal = ghostty.createTerminal(20, 5);
terminal.write("\x1b[H\x1b[2J\x1b[3J");
terminal.write("\x1b[2J\x1b[HOpenAI Codex\r\n> ");
terminal.update();
const cells = terminal.getViewport(); // row-major GhosttyCell[cols * rows]
const cursor = terminal.getCursor();
```

Observed result in Bun with no globals installed:

```json
{
  "rows": ["OpenAI Codex", ">", "", "", ""],
  "cursor": { "x": 2, "y": 1, "viewportX": 2, "viewportY": 1, "visible": 1, "blinking": false, "style": "block" },
  "viewportCells": 100
}
```

The exact read surface is:

| Operation | Working API |
| --- | --- |
| Load the existing core | `await Ghostty.load(wasmPath?)` |
| Create a headless state machine | `ghostty.createTerminal(cols, rows)` |
| Feed raw PTY output | `terminal.write(string | Uint8Array)` |
| Refresh render state | `terminal.update()` |
| Read the active screen | `terminal.getViewport()` → row-major `GhosttyCell[]` |
| Read a single visible row | `terminal.getLine(y)` → `GhosttyCell[] | null` |
| Read cursor | `terminal.getCursor()` |
| Read complex cell text | `terminal.getGraphemeString(row, col)` |
| Resize/free | `terminal.resize(cols, rows)` / `terminal.free()` |

The underlying WASM export is `ghostty_render_state_get_viewport`; the JavaScript wrapper does **not** hide
it. The browser-shaped `Terminal` merely delays construction of this lower-level object until `open()`.
There is no screen serializer, and none is needed for bottom-row classification.

Two previously measured ghostty-web 0.4.0 caveats also apply headlessly and are handled by the prototype:

- A newly allocated terminal can inherit recycled cell memory after another terminal is freed. The factory
  writes `\x1b[H\x1b[2J\x1b[3J` before accepting PTY bytes.
- The wrapper's zero-length `write()` throws `RangeError: offset is out of bounds`. `screenGrid()` skips the
  WASM write for an empty chunk and still returns a snapshot.

### 2.3 OSC retention is a separate byte-stream concern

The compiled module exports a standalone `ghostty_osc_*` parser, but `GhosttyTerminal` exposes no retained
terminal-title or progress getter. The high-level browser `Terminal.onTitleChange` is not suitable: it only
regex-scans string writes containing a complete OSC sequence, handles 0/1/2 only, and depends on `open()`.

The prototype therefore mirrors Herdr's shape: the same raw bytes go to ghostty-vt and to a bounded,
chunk-safe passive scanner. It retains the last OSC 0/2 value as `oscTitle` and OSC 9 value as
`oscProgress`, accepts BEL and ST terminators even when split across chunks, strips control characters,
caps each retained value at 256 characters, and caps an in-flight OSC at 4,096 bytes.

## 3. Path B — minimal line-grid fallback

### 3.1 Current small-library assessment

Registry metadata was read on 2026-07-20 with
`npm view <package> version license dist.unpackedSize dependencies time.modified --json`.

| Candidate | Latest version | License | Unpacked size | Empirical/API finding |
| --- | ---: | --- | ---: | --- |
| [`@ansi-tools/parser`](https://www.npmjs.com/package/@ansi-tools/parser) | 1.0.17 | ISC | 26,252 B | Zero dependencies and tokenizes CSI/OSC/DCS, but returns control-code tokens, not cursor or grid state. A screen emulator still has to be written. |
| [`ansi-sequence-parser`](https://www.npmjs.com/package/ansi-sequence-parser) | 1.1.3 | MIT | 22,785 B | Zero dependencies and keeps SGR/style parse state, but models styled text rather than cursor-addressed terminal rows. |
| [`node-ansiparser`](https://www.npmjs.com/package/node-ansiparser) | 2.2.1 | MIT | 176,093 B | Streaming parser callbacks only. Its grid companion is `node-ansiterminal` 0.2.1-beta, an old incomplete beta with no current stable release. |

The maintained small packages remove tokenization work, but none supplies the required visible line grid.
Adding one still creates a second, partial terminal emulator whose behavior can diverge from the ghostty
screen shown in the browser.

### 3.2 Purpose-built parser probe

A throwaway 218-line TypeScript state machine was also exercised. It implemented incremental UTF-8 input,
CR/LF/BS/tab, fixed visible rows, autowrap/scroll, CSI `A/B/C/D/E/F/G/H/f/d/J/K/s/u`, SGR skip, ESC 7/8,
and chunk-safe OSC 0/2/9. The same cursor-addressed fixture used by the chosen prototype returned:

```json
{"rows":["gamma","deREADY",">"],"cursor":{"x":2,"y":5},"title":"OpenAI Codex","progress":"4;3;"}
```

On the machine above it processed 33,556,032 bytes in 968.289 ms while returning the bottom 24 rows after
every 1,728-byte chunk: **34,654,992 bytes/s** (33.05 MiB/s). Thus a small parser is computationally viable.

It is not the recommendation. The 218 lines do not implement scroll regions, insert/delete character or
line operations, alternate-screen switching, origin/wrap modes, reverse index, DEC character sets, Unicode
cell widths, or combining graphemes. Agent TUIs exercise those operations, so a passing synthetic fixture
would not prove that manifest rules see the same screen as the user. Filling those gaps means maintaining a
terminal emulator, not a classification-only parser.

## 4. Chosen prototype and exact contract

The working implementation is `apps/daemon/src/detect/spike-grid.ts`. It imports the vendored advanced
wrapper directly, does not alter `vendor/ghostty-web`, and adds no package dependency. This excerpt is
executable and proves cursor movement, SGR handling, a split OSC title, OSC 9 progress, and bottom-three-row
readback:

```ts
import { GhosttyScreenGrid } from "./apps/daemon/src/detect/spike-grid";

const encode = (value: string) => new TextEncoder().encode(value);
const grid = await GhosttyScreenGrid.create({ cols: 24, rows: 6, bottomRows: 3 });

grid.screenGrid(encode("\x1b]2;OpenAI Co")); // split the title payload
grid.screenGrid(encode("dex\x07\x1b]9;4;3;\x1b")); // split the progress ST terminator
const result = grid.screenGrid(
  encode(
    "\\" +
      "\x1b[2J\x1b[Htop\r\nalpha\r\nbeta\r\ngamma\r\ndelta\r\nomega" +
      "\x1b[5;1H\x1b[2C\x1b[32mREADY\x1b[0m\x1b[6;1H\x1b[2K> ",
  ),
);

console.log(result);
// {
//   rows: ["gamma", "deREADY", ">"],
//   oscTitle: "OpenAI Codex",
//   oscProgress: "4;3;"
// }

grid.dispose();
```

Reproduction:

```bash
bun apps/daemon/src/detect/spike-grid.ts
```

Output:

```json
{"rows":["gamma","deREADY",">"],"oscTitle":"OpenAI Codex","oscProgress":"4;3;","cursor":{"x":2,"y":5}}
```

**Tasks 4/6 contract (stateful, one instance per PTY session):**

```ts
screenGrid(bytes: Uint8Array): {
  rows: string[];
  oscTitle: string | null;
  oscProgress: string | null;
}
```

`bytes` is the next PTY output chunk, not the entire history. `rows` is the configured bottom N rows of the
current active viewport after applying that chunk, with trailing spaces removed and blank rows represented
as `""`. OSC fields retain the last completed matching sequence. PTY resize calls `resize(cols, rows)` on
the same reader. A shared `Ghostty` instance may be passed to each reader factory so the daemon can share one
WASM instance while keeping one terminal state per session.

## 5. Throughput

Command:

```bash
bun apps/daemon/src/detect/spike-grid.ts --bench
```

The benchmark used a 120×40 terminal, returned the bottom 24 row strings after **every** 3,552-byte chunk,
and processed 16,779,648 bytes per round. It includes OSC scanning, ghostty-vt parsing, render-state update,
the full viewport cell read, and string construction; it excludes the one-time WASM load.

```text
rounds: 23,897,501 / 23,743,942 / 22,555,462 / 24,020,724 / 24,055,774 bytes/s
median: 23,897,501 bytes/s (22.79 MiB/s, about 6,728 chunks/s)
```

This is comfortably above PTY output rates and is cheap enough to run on every chunk. Tasks 4/6 should still
use the content sequence to skip manifest evaluation when no new bytes arrived; that is separate from
maintaining the grid itself.

## 6. Gate verdict

**PASS-ghostty.** A viable server-side rendered-screen read exists today using the pinned vendored artifact.
Use the exported `Ghostty → GhosttyTerminal → update() → getViewport()` API for grid truth and the bounded
passive scanner for retained OSC 0/2/9. Do not use the DOM `Terminal`, an OffscreenCanvas shim, xterm.js, or
the purpose-built fallback parser.

The partial-gate contingency is therefore not needed. If this low-level export disappears in a future vendor
upgrade and no equivalent ghostty read path remains, process-tree + OSC layers can still ship independently
as `PARTIAL-osc+process-only`; only the manifest screen-pattern layer would be blocked.
