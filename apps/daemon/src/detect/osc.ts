const ESC = 0x1b;
const BEL = 0x07;
const ST_FINAL = 0x5c;
const OSC_FINAL = 0x5d;
const CAN = 0x18;
const SUB = 0x1a;

/** Herdr `src/pane/osc.rs:410`, recorded in research §3b. */
const MAX_RETAINED_CHARS = 256;
/** The Task-1 proof bounds an unterminated in-flight OSC at 4 KiB. */
const MAX_OSC_BYTES = 4_096;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const BRAILLE_SPINNER = /^[\u2800-\u28ff]/u;
const IDLE_KEYWORD = /(?<![\w./\\-])(?:ready|idle|done)(?![\w-])/iu;
const WORKING_KEYWORD = /(?<![\w./\\-])(?:working|thinking|running)(?![\w-])/iu;
const ACTION_REQUIRED = /action required/iu;
const ATTENTION_KEYWORD = /permission|waiting/iu;
const DONE_PROGRESS = /^4;0(?:;|$)/u;

type ScannerState = "ground" | "escape" | "osc" | "oscEscape";

export type OscClassification = "working" | "idle" | "blocked";

/**
 * Passive, chunk-safe OSC metadata scanner for raw PTY output.
 *
 * Keep one scanner per PTY and feed it the same bytes sent to the terminal.
 * OSC values stay daemon-side; only `classifyOsc`'s enum may cross into UI
 * state. This mirrors Herdr's content-free retention in `pane/osc.rs:408-528`.
 */
export class OscScanner {
  private readonly decoder = new TextDecoder();
  private readonly payload: number[] = [];
  private state: ScannerState = "ground";
  private overflowed = false;

  title: string | null = null;
  progress: string | null = null;

  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      switch (this.state) {
        case "ground":
          if (byte === ESC) this.state = "escape";
          break;
        case "escape":
          if (byte === OSC_FINAL) {
            this.startOsc();
          } else {
            this.state = byte === ESC ? "escape" : "ground";
          }
          break;
        case "osc":
          this.consumeOscByte(byte);
          break;
        case "oscEscape":
          this.consumeOscEscapeByte(byte);
          break;
      }
    }
  }

  /**
   * Herdr clears retained OSC evidence on foreground-agent change
   * (`src/pane.rs:722-724`). Reset the partial parser too: bytes begun by the
   * previous process must not be completed by the next one.
   */
  clearOnAgentChange(): void {
    this.title = null;
    this.progress = null;
    this.resetSequence();
  }

  private consumeOscByte(byte: number): void {
    if (byte === BEL) {
      this.commitOsc();
    } else if (byte === ESC) {
      this.state = "oscEscape";
    } else if (byte === CAN || byte === SUB) {
      this.resetSequence();
    } else {
      this.push(byte);
    }
  }

  private consumeOscEscapeByte(byte: number): void {
    if (byte === ST_FINAL) {
      this.commitOsc();
      return;
    }

    // A non-ST ESC is payload and will be removed by control sanitization.
    // Process the following byte normally so BEL/CAN/SUB retain their meaning.
    this.push(ESC);
    this.state = "osc";
    this.consumeOscByte(byte);
  }

  private startOsc(): void {
    this.payload.length = 0;
    this.overflowed = false;
    this.state = "osc";
  }

  private push(byte: number): void {
    if (this.payload.length < MAX_OSC_BYTES) {
      this.payload.push(byte);
    } else {
      this.overflowed = true;
    }
  }

  private commitOsc(): void {
    if (!this.overflowed) {
      const separator = this.payload.indexOf(0x3b);
      if (separator > 0) {
        const command = String.fromCharCode(...this.payload.slice(0, separator));
        const value = this.sanitize(this.payload.slice(separator + 1));

        if (command === "0" || command === "2") this.title = value;
        if (command === "9") this.progress = value;
      }
    }

    this.resetSequence();
  }

  private sanitize(bytes: number[]): string {
    const decoded = this.decoder.decode(Uint8Array.from(bytes));
    const withoutControls = decoded.replace(CONTROL_CHARACTERS, "");
    // Rust's `.chars().take(256)` cap counts Unicode scalar values, not UTF-16
    // code units (Herdr `src/pane/osc.rs:410`).
    return Array.from(withoutControls).slice(0, MAX_RETAINED_CHARS).join("");
  }

  private resetSequence(): void {
    this.payload.length = 0;
    this.overflowed = false;
    this.state = "ground";
  }
}

/**
 * Convert volunteered OSC metadata to the only value allowed to leave the
 * daemon-side matcher. Unknown evidence remains null for the other layers.
 */
export function classifyOsc(
  title: string | null,
  progress: string | null,
): OscClassification | null {
  if (title !== null) {
    const first = title[0];

    // Herdr `claude.toml:osc_title_working`; live-confirmed for Claude and
    // Codex, and Orca records the same range for Grok/Pi (research §2.2).
    if (BRAILLE_SPINNER.test(title)) return "working";

    // Claude's U+2733 means not-working, never blocked. Live CC 2.1.215 shows
    // this same title during pending permission/question UI, so this guard must
    // precede every blocked keyword (`cc-codex-hook-contract.md`, Claim 6).
    if (first === "✳") return "idle";

    // Gemini's volunteered title glyph table: Orca
    // `agent-title-core.ts:21-24`, recorded in research §2.2.
    if (first === "✋") return "blocked";
    if (first === "✦" || first === "⏲") return "working";
    if (first === "◇") return "idle";

    // Codex 0.144.6 emitted this literal about 4 ms after PermissionRequest
    // (`cc-codex-hook-contract.md`, Claim 7c). Orca additionally records the
    // plain `permission`/`waiting` attention words in research §2.2; the
    // Claude prefix guards above deliberately veto all three.
    if (ACTION_REQUIRED.test(title) || ATTENTION_KEYWORD.test(title)) return "blocked";

    // Orca `agent-title-core.ts:31-41`: path-safe lookarounds reject path
    // segments such as `~/codex/ready` and embedded words like `reworking`.
    if (WORKING_KEYWORD.test(title)) return "working";
    if (IDLE_KEYWORD.test(title)) return "idle";
  }

  // Herdr's `^4;0` done rule remains valid for agents that emit OSC 9. Claude
  // Code 2.1.215 does not emit OSC 9 at all (live-refuted in Claim 6), so this
  // is deliberately only a passive legacy/other-agent signal.
  if (progress !== null && DONE_PROGRESS.test(progress)) return "idle";

  return null;
}
