import {
  Ghostty,
  type GhosttyCell,
  type GhosttyTerminal,
} from "../../../../vendor/ghostty-web/lib/ghostty";
import { OscScanner } from "./osc";
import type { ScreenGrid } from "./types";

const CLEAN_SCREEN = "\x1b[H\x1b[2J\x1b[3J";

export type ScreenGridSnapshot = ScreenGrid;
export type { ScreenGrid } from "./types";

export interface GhosttyScreenGridOptions {
  cols?: number;
  rows?: number;
  bottomRows?: number;
  ghostty?: Ghostty;
}

/**
 * Spike contract: keep one instance per PTY session and feed every output chunk
 * to screenGrid(). The returned rows are the rendered bottom viewport rows.
 */
export class GhosttyScreenGrid {
  private readonly osc = new OscScanner();
  private disposed = false;

  private constructor(
    private readonly terminal: GhosttyTerminal,
    private readonly bottomRows: number | null,
  ) {}

  static async create(options: GhosttyScreenGridOptions = {}): Promise<GhosttyScreenGrid> {
    const cols = positiveInteger(options.cols ?? 80, "cols");
    const rows = positiveInteger(options.rows ?? 24, "rows");
    // By default retain the full active viewport (24 rows at default geometry)
    // so whole_recent and both prompt-box borders remain available. An explicit
    // bottomRows keeps the Task-1 benchmark/probe's bounded-tail mode.
    const bottomRows =
      options.bottomRows === undefined ? null : positiveInteger(options.bottomRows, "bottomRows");
    const ghostty = options.ghostty ?? (await Ghostty.load());
    const terminal = ghostty.createTerminal(cols, rows);

    // ghostty-web 0.4.0 can recycle stale cell memory after free(); sanitize
    // each new headless terminal before accepting bytes from its PTY.
    terminal.write(CLEAN_SCREEN);
    return new GhosttyScreenGrid(terminal, bottomRows);
  }

  screenGrid(bytes: Uint8Array): ScreenGridSnapshot {
    this.assertLive();
    if (bytes.byteLength > 0) {
      this.osc.feed(bytes);
      this.terminal.write(bytes);
    }
    return this.snapshot();
  }

  snapshot(): ScreenGridSnapshot {
    this.assertLive();
    this.terminal.update();
    const cells = this.terminal.getViewport();
    const firstRow =
      this.bottomRows === null ? 0 : Math.max(0, this.terminal.rows - this.bottomRows);
    const rows: string[] = [];

    for (let row = firstRow; row < this.terminal.rows; row += 1) {
      rows.push(this.readRow(cells, row));
    }

    return {
      rows,
      oscTitle: this.osc.title,
      oscProgress: this.osc.progress,
    };
  }

  cursor(): { x: number; y: number } {
    this.assertLive();
    const cursor = this.terminal.getCursor();
    return { x: cursor.x, y: cursor.y };
  }

  resize(cols: number, rows: number): void {
    this.assertLive();
    this.terminal.resize(positiveInteger(cols, "cols"), positiveInteger(rows, "rows"));
  }

  /** Prevent retained or partial OSC evidence from crossing agent identities. */
  clearOnAgentChange(): void {
    this.assertLive();
    this.osc.clearOnAgentChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.free();
  }

  private readRow(cells: GhosttyCell[], row: number): string {
    let text = "";
    const offset = row * this.terminal.cols;

    for (let col = 0; col < this.terminal.cols; col += 1) {
      const cell = cells[offset + col];
      if (!cell || cell.width === 0) continue;

      if (cell.grapheme_len > 0) {
        text += this.terminal.getGraphemeString(row, col);
      } else if (cell.codepoint === 0) {
        text += " ";
      } else if (cell.codepoint <= 0x10ffff) {
        text += String.fromCodePoint(cell.codepoint);
      } else {
        text += "�";
      }
    }

    return text.trimEnd();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("GhosttyScreenGrid has been disposed");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

async function runProof(): Promise<void> {
  const encoder = new TextEncoder();
  const grid = await GhosttyScreenGrid.create({ cols: 24, rows: 6, bottomRows: 3 });

  try {
    grid.screenGrid(encoder.encode("\x1b]2;OpenAI Co"));
    grid.screenGrid(encoder.encode("dex\x07\x1b]9;4;3;\x1b"));
    const result = grid.screenGrid(
      encoder.encode(
        "\\" +
          "\x1b[2J\x1b[Htop\r\nalpha\r\nbeta\r\ngamma\r\ndelta\r\nomega" +
          "\x1b[5;1H\x1b[2C\x1b[32mREADY\x1b[0m\x1b[6;1H\x1b[2K> ",
      ),
    );
    const cursor = grid.cursor();
    const expected: ScreenGridSnapshot = {
      rows: ["gamma", "deREADY", ">"],
      oscTitle: "OpenAI Codex",
      oscProgress: "4;3;",
    };

    if (JSON.stringify(result) !== JSON.stringify(expected)) {
      throw new Error(`unexpected proof result: ${JSON.stringify(result)}`);
    }
    console.log(JSON.stringify({ ...result, cursor }));
  } finally {
    grid.dispose();
  }
}

async function runBenchmark(): Promise<void> {
  const encoder = new TextEncoder();
  const unit = "\x1b[32mworking\x1b[0m payload 0123456789\r\n";
  const chunk = encoder.encode(unit.repeat(96));
  const grid = await GhosttyScreenGrid.create({ cols: 120, rows: 40, bottomRows: 24 });
  const iterations = Math.ceil((16 * 1024 * 1024) / chunk.byteLength);
  const rounds: number[] = [];

  try {
    for (let index = 0; index < 64; index += 1) grid.screenGrid(chunk);
    for (let round = 0; round < 5; round += 1) {
      const start = performance.now();
      for (let index = 0; index < iterations; index += 1) grid.screenGrid(chunk);
      const elapsedMs = performance.now() - start;
      rounds.push((iterations * chunk.byteLength) / (elapsedMs / 1_000));
    }
  } finally {
    grid.dispose();
  }

  const sorted = [...rounds].sort((left, right) => left - right);
  const medianBytesPerSecond = Math.round(sorted[Math.floor(sorted.length / 2)]);
  console.log(
    JSON.stringify({
      geometry: "120x40",
      bottomRows: 24,
      chunkBytes: chunk.byteLength,
      bytesPerRound: iterations * chunk.byteLength,
      rounds: rounds.map(Math.round),
      medianBytesPerSecond,
    }),
  );
}

if (import.meta.main) {
  await runProof();
  if (Bun.argv.includes("--bench")) await runBenchmark();
}
