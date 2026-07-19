// Task 3 spike: ghostty-web hard gate (soak / throughput / replay + IME approximation).
// Uses ghostty-web's REAL API (vendored source build, see docs/research/ghostty-web-spike.md):
//   import { init, Terminal } from "ghostty-web";  await init();  new Terminal({ cols, rows });
//   t.open(el); t.write(data, cb?); t.onData(cb); t.resize(cols, rows); t.dispose();
//   readback: t.buffer.active.getLine(y).translateToString(true) / .getCell(x).getFgColor()
import { init, Terminal } from "ghostty-web";

type PhaseResult = { pass: boolean; [k: string]: unknown };
interface SpikeResults {
  done: boolean;
  failed: boolean;
  error?: string;
  pageErrors: string[];
  soak?: PhaseResult;
  throughput?: PhaseResult;
  replay?: PhaseResult;
  ime?: PhaseResult;
  recycle?: PhaseResult;
}
const results: SpikeResults = { done: false, failed: false, pageErrors: [] };
// ghostty-web 0.4.0 recycles freed WASM terminal memory WITHOUT clearing it: a
// fresh Terminal can start with a disposed terminal's screen content (see the
// `recycle` phase below, and docs/research/ghostty-web-spike.md). Until fixed
// upstream, every real pane must be sanitized right after open() with a full
// ANSI clear. Terminal.reset() does NOT help (it is itself free+create).
const SANITIZE = "\x1b[H\x1b[2J\x1b[3J"; // cursor home + erase display + erase scrollback
(window as unknown as { __spikeResults: SpikeResults }).__spikeResults = results;
window.addEventListener("error", (e) => results.pageErrors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => results.pageErrors.push(String(e.reason)));

const logEl = document.getElementById("log")!;
const grid = document.getElementById("grid")!;
const log = (m: string) => {
  logEl.textContent += m + "\n";
  console.log("[spike] " + m);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Last `n` buffer lines (right-trimmed), oldest first. */
function lastLines(t: Terminal, n: number): string[] {
  const buf = t.buffer.active;
  const out: string[] = [];
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? "<missing line>");
  }
  return out;
}

function newPane(cols: number, rows: number, sanitize = true): { t: Terminal; el: HTMLDivElement } {
  const el = document.createElement("div");
  el.style.minHeight = "120px";
  grid.appendChild(el);
  const t = new Terminal({ cols, rows });
  t.open(el);
  if (sanitize) t.write(SANITIZE); // required — see SANITIZE comment above
  return { t, el };
}

// ---------------------------------------------------------------------------
// (a) create/destroy soak: 20 cycles x 4 panes, with per-pane buffer readback
// ---------------------------------------------------------------------------
async function soak(): Promise<PhaseResult> {
  const CYCLES = 20;
  const PANES = 4;
  const heapBefore = (performance as any).memory?.usedJSHeapSize ?? null;
  let created = 0;
  let verified = 0;
  const failures: string[] = [];
  const t0 = performance.now();
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const panes: { t: Terminal; el: HTMLDivElement }[] = [];
    for (let i = 0; i < PANES; i++) {
      const pane = newPane(80, 24);
      pane.t.write(`\x1b[1;3${(i % 6) + 1}mcycle ${cycle} pane ${i}\x1b[0m\r\nsecond line c${cycle}p${i}\r\n`);
      panes.push(pane);
      created++;
    }
    await nextFrame(); // let one render pass happen while all 4 are alive
    await sleep(20);
    for (let i = 0; i < PANES; i++) {
      const text = lastLines(panes[i].t, 24).join("\n");
      if (text.includes(`cycle ${cycle} pane ${i}`) && text.includes(`second line c${cycle}p${i}`)) {
        verified++;
      } else {
        failures.push(`cycle ${cycle} pane ${i}: buffer content wrong: ${JSON.stringify(text.slice(0, 200))}`);
      }
    }
    for (const { t, el } of panes) {
      t.dispose();
      el.remove();
    }
  }
  const ms = Math.round(performance.now() - t0);
  const heapAfter = (performance as any).memory?.usedJSHeapSize ?? null;
  return {
    pass: created === CYCLES * PANES && verified === CYCLES * PANES && failures.length === 0,
    created,
    verified,
    ms,
    heapBefore,
    heapAfter,
    failures,
  };
}

// ---------------------------------------------------------------------------
// (b) throughput: 5 MiB of 120-byte lines into one 120x40 terminal
// ---------------------------------------------------------------------------
async function throughput(): Promise<PhaseResult> {
  const { t, el } = newPane(120, 40);
  const line = "y".repeat(118) + "\r\n"; // 120 bytes
  const marker = ("THROUGHPUT-END " + "z".repeat(118)).slice(0, 118) + "\r\n"; // 120 bytes
  const n = Math.ceil((5 * 1024 * 1024) / line.length); // 43691 lines = 5,242,920 bytes
  const bytes = n * line.length;
  const start = performance.now();
  let aborted = false;
  let written = 0;
  for (let i = 0; i < n - 1; i++) {
    t.write(line);
    written++;
    if ((i & 4095) === 0 && performance.now() - start > 30_000) {
      aborted = true;
      break;
    }
  }
  // NOTE: do NOT use t.write("", cb) as a render-fence — zero-length writes crash
  // ghostty-web 0.4.0 (alloc(0) returns a bad pointer; RangeError in Uint8Array.set).
  // Documented in the findings doc; Task 13's wrapper must guard empty chunks.
  let renderDone!: () => void;
  const rendered = new Promise<void>((r) => (renderDone = r));
  t.write(marker, renderDone); // callback fires on the next rAF after processing
  written++;
  const syncMs = performance.now() - start;
  await rendered;
  const renderMs = performance.now() - start;
  const tail = lastLines(t, 3).join("\n");
  const markerVisible = tail.includes("THROUGHPUT-END");
  t.dispose();
  el.remove();
  const mib = bytes / (1024 * 1024);
  return {
    pass: !aborted && syncMs < 10_000 && markerVisible,
    bytes,
    mib: Number(mib.toFixed(2)),
    lines: written,
    syncMs: Math.round(syncMs),
    renderMs: Math.round(renderMs),
    mibPerSec: Number((mib / (syncMs / 1000)).toFixed(1)),
    markerVisible,
    aborted,
  };
}

// ---------------------------------------------------------------------------
// (c) replay-on-reattach: ~200KB colored ring -> snapshot -> dispose ->
//     fresh terminal -> re-feed same bytes -> snapshots must match (text+color)
// ---------------------------------------------------------------------------
interface CellProbe {
  y: string; // which line the probe was taken from
  O: { ch: string; fg: number; fgMode: number; bold: number };
  bang: { ch: string; fg: number; fgMode: number; bold: number };
  defaultFg: number; // fg of an uncolored cell on the same line, for contrast
}
function probeColors(t: Terminal): CellProbe | null {
  const buf = t.buffer.active;
  // Find the line for "replay line 1999" scanning the last 40 lines.
  for (let y = buf.length - 1; y >= Math.max(0, buf.length - 40); y--) {
    const lineObj = buf.getLine(y);
    if (!lineObj) continue;
    const text = lineObj.translateToString(true);
    if (!text.startsWith("replay line 1999 ")) continue;
    const o = lineObj.getCell(76); // 'O' of OK (green, SGR 32)
    const bang = lineObj.getCell(78); // '!' (bold magenta, SGR 1;35)
    const plain = lineObj.getCell(0); // 'r' of replay (default fg)
    if (!o || !bang || !plain) return null;
    return {
      y: `bufferLine ${y}`,
      O: { ch: o.getChars(), fg: o.getFgColor(), fgMode: o.getFgColorMode(), bold: o.isBold() },
      bang: { ch: bang.getChars(), fg: bang.getFgColor(), fgMode: bang.getFgColorMode(), bold: bang.isBold() },
      defaultFg: plain.getFgColor(),
    };
  }
  return null;
}

async function replay(): Promise<PhaseResult> {
  // Build the ring: 2000 lines, each padded so 'O','K','!' land at cols 76,77,78.
  const ring: string[] = [];
  let ringBytes = 0;
  for (let i = 0; i < 2000; i++) {
    const pad = "x".repeat(62 - String(i).length);
    const l = `replay line ${i} ${pad} \x1b[32mOK\x1b[0m\x1b[1;35m!\x1b[0m\r\n`;
    ring.push(l);
    ringBytes += l.length;
  }

  // Original terminal.
  const a = newPane(120, 40);
  for (const chunk of ring) a.t.write(chunk);
  await nextFrame();
  const beforeText = lastLines(a.t, 40);
  const beforeColors = probeColors(a.t);
  a.t.dispose();
  a.el.remove();

  // Fresh terminal, re-feed identical bytes (ring replay simulation).
  const b = newPane(120, 40);
  b.el.style.gridColumn = "1 / -1"; // full width so all 120 cols are visible for the human check
  for (const chunk of ring) b.t.write(chunk);
  await nextFrame();
  const afterText = lastLines(b.t, 40);
  const afterColors = probeColors(b.t);
  const bufferLength = b.t.buffer.active.length;
  const scrollbackLength = b.t.getScrollbackLength();
  // Keep pane b alive & rendered for human inspection/screenshot.

  const textEqual = beforeText.join("\n") === afterText.join("\n");
  const lastNonEmpty = [...afterText].reverse().find((l) => l.length > 0) ?? "";
  const lastLineCorrect = lastNonEmpty.startsWith("replay line 1999 ") && lastNonEmpty.endsWith("OK!");
  const colorsCaptured = beforeColors !== null && afterColors !== null;
  const colorsEqual = colorsCaptured && JSON.stringify(beforeColors) === JSON.stringify(afterColors);
  const colorsNonDefault =
    colorsCaptured &&
    afterColors!.O.fg !== afterColors!.defaultFg && // green really applied
    afterColors!.bang.fg !== afterColors!.defaultFg && // magenta really applied
    afterColors!.O.ch === "O" &&
    afterColors!.bang.ch === "!" &&
    afterColors!.bang.bold !== 0 &&
    afterColors!.O.bold === 0;
  return {
    pass: textEqual && lastLineCorrect && colorsEqual && colorsNonDefault,
    ringBytes,
    ringLines: ring.length,
    textEqual,
    lastNonEmpty,
    lastLineCorrect,
    colorsEqual,
    colorsNonDefault,
    beforeColors,
    afterColors,
    bufferLength,
    scrollbackLength,
  };
}

// ---------------------------------------------------------------------------
// (e) recycle probe: documents the create-after-dispose stale-memory bug and
//     verifies the ANSI-clear workaround. Uses RAW panes (sanitize=false).
// ---------------------------------------------------------------------------
async function recycleProbe(): Promise<PhaseResult> {
  const read = (t: Terminal) => lastLines(t, 6).join("\n");

  // Seed a terminal with a marker, dispose it.
  const seed = newPane(60, 6, false);
  seed.t.write("RECYCLE-MARKER-ONE\r\nRECYCLE-MARKER-TWO\r\n");
  seed.t.dispose();
  seed.el.remove();

  // A raw fresh terminal with the same geometry: does it inherit the content?
  const raw = newPane(60, 6, false);
  const rawContent = read(raw.t);
  const leakDetected = rawContent.includes("RECYCLE-MARKER");

  // Workaround: full ANSI clear must leave it pristine.
  raw.t.write(SANITIZE);
  const afterClear = read(raw.t);
  const workaroundClears = afterClear.trim() === "";

  // Terminal.reset() is NOT a fix (it is free+create, which recycles again).
  raw.t.write("RESET-CHECK-SEED\r\n");
  raw.t.reset();
  const afterReset = read(raw.t);
  const resetLeaks = afterReset.includes("RESET-CHECK-SEED") || afterReset.includes("RECYCLE-MARKER");
  raw.t.dispose();
  raw.el.remove();

  // The gate here is the WORKAROUND, not the bug: leakDetected documents the
  // upstream defect (expected true on 0.4.0); workaroundClears must be true.
  return { pass: workaroundClears, leakDetected, workaroundClears, resetLeaks, rawContent, afterReset };
}

// ---------------------------------------------------------------------------
// (d) IME approximation: synthetic composition events (NOT a real macOS IME).
//     Real check with macOS Korean 2-Set input remains a manual step.
// ---------------------------------------------------------------------------
async function imeApprox(): Promise<PhaseResult> {
  const { t, el } = newPane(80, 10);
  const received: string[] = [];
  t.onData((d) => received.push(d));
  t.focus();
  await sleep(30);
  const target = el.querySelector("textarea") ?? el;
  const fire = (type: string, data: string) =>
    target.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: true }));
  // Korean 2-Set composition of "한": ㅎ -> 하 -> 한, then commit.
  fire("compositionstart", "");
  fire("compositionupdate", "ㅎ"); // ㅎ
  fire("compositionupdate", "하"); // 하
  fire("compositionupdate", "한"); // 한
  fire("compositionend", "한");
  await sleep(50);
  const joined = received.join("");
  const committedOnce = joined === "한"; // exactly one commit, no duplicates
  // Echo the committed text back like a PTY would, verify it lands in the buffer.
  t.write("한");
  const echoed = lastLines(t, 10).join("\n").includes("한");
  return {
    pass: committedOnce && echoed,
    synthetic: true,
    note: "CompositionEvent simulation only — manual macOS Korean 2-Set IME check pending",
    onDataReceived: JSON.stringify(joined),
    committedOnce,
    echoed,
  };
}

// ---------------------------------------------------------------------------
try {
  await init(); // loads ghostty-vt.wasm (shared instance for all terminals)
  log("init: ghostty-vt.wasm loaded");

  results.soak = await soak();
  log(
    `soak: ${results.soak.pass ? "PASS" : "FAIL"} — ${results.soak.verified}/${results.soak.created} panes verified across 20x4 create/destroy in ${results.soak.ms}ms`,
  );

  results.throughput = await throughput();
  log(
    `throughput: ${results.throughput.pass ? "PASS" : "FAIL"} — ${results.throughput.mib}MiB in ${results.throughput.syncMs}ms sync (${results.throughput.mibPerSec}MiB/s), rendered by ${results.throughput.renderMs}ms`,
  );

  results.replay = await replay();
  log(
    `replay: ${results.replay.pass ? "PASS" : "FAIL"} — textEqual=${results.replay.textEqual} colorsEqual=${results.replay.colorsEqual} colorsNonDefault=${results.replay.colorsNonDefault} last=${JSON.stringify(String(results.replay.lastNonEmpty).slice(0, 40))}...`,
  );

  results.ime = await imeApprox();
  log(
    `ime(synthetic): ${results.ime.pass ? "PASS" : "FAIL"} — onData=${results.ime.onDataReceived} (manual macOS Korean 2-Set check still pending)`,
  );

  results.recycle = await recycleProbe();
  log(
    `recycle: ${results.recycle.pass ? "PASS" : "FAIL"} — staleLeakOnCreate=${results.recycle.leakDetected} (upstream bug), ansiClearWorkaround=${results.recycle.workaroundClears}, resetAlsoLeaks=${results.recycle.resetLeaks}`,
  );

  results.failed =
    !results.soak.pass ||
    !results.throughput.pass ||
    !results.replay.pass ||
    !results.recycle.pass ||
    results.pageErrors.length > 0;
  log(results.failed ? "SPIKE: GATE FAIL" : "SPIKE: GATE PASS (automated checks)");
} catch (e) {
  results.failed = true;
  results.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  log("FATAL: " + results.error);
} finally {
  results.done = true;
}
