/* rvmp showcase — scene program. Pure-CSS choreography (see showcase.css);
 * every scene is composed on the player's fixed 1120×700 canvas. */

import React, { type CSSProperties, type ReactNode } from "react";

export type SceneProps = { replay: () => void };
export type SceneDef = {
  id: string;
  eyebrow: string;
  title: string;
  caption: string;
  duration: number;
  Component: React.ComponentType<SceneProps>;
};

/* ── Inline icons (stroke set, mirroring the app's icon grammar) ─────────── */

const GLYPHS: Record<string, ReactNode> = {
  play: <path d="M5 3.5 12 8l-7 4.5Z" />,
  pause: <path d="M5 4h2.2v8H5zM8.8 4H11v8H8.8z" />,
  left: <path d="M9.5 4 5.5 8l4 4" />,
  right: <path d="M6.5 4l4 4-4 4" />,
  max: <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  min: <path d="M6 3v3H3M10 6h3V3M13 10h-3v3M6 13v-3H3" />,
  replay: (
    <>
      <path d="M4 3.3v4h4" />
      <path d="M4.4 7.1a4.8 4.8 0 1 1 .8 4.2" />
    </>
  ),
  check: <path d="M3 8.2 6.3 11.5 13 4.8" />,
  question: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 6.2A1.7 1.7 0 0 1 8.2 4.8c1 0 1.8.6 1.8 1.5 0 1.5-2 1.5-2 3" />
      <path d="M8 11.7h.01" />
    </>
  ),
  merge: (
    <>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5v6M5.5 4.2C9 4.8 8.5 8 10.5 8" />
    </>
  ),
  send: <path d="M3 4h6v4M9 4 3.5 9.5" />,
  lock: (
    <>
      <rect x="4" y="7" width="8" height="6" rx="1" />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 8S4.5 4.5 8 4.5 13.5 8 13.5 8 11.5 11.5 8 11.5 2.5 8 2.5 8Z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  file: <path d="M4 2.5h5l3 3v8H4ZM9 2.5v3h3" />,
  git: (
    <>
      <circle cx="4.5" cy="4" r="1.7" />
      <circle cx="4.5" cy="12" r="1.7" />
      <circle cx="11.5" cy="6" r="1.7" />
      <path d="M4.5 5.7v4.6M11.5 7.7c0 2.5-4.5 2-4.5 4" />
    </>
  ),
  term: <path d="M3.5 4.5 7 8l-3.5 3.5M8 11.5h5" />,
  phone: <rect x="5" y="2.5" width="6" height="11" rx="1.5" />,
  star: (
    <path
      d="M8 2.6l1.7 3.4 3.8.6-2.7 2.7.6 3.8L8 11.4l-3.4 1.7.6-3.8L2.5 6.6l3.8-.6Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
};

export function I({ n, s = 14, style }: { n: keyof typeof GLYPHS | string; s?: number; style?: CSSProperties }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={style}
    >
      {GLYPHS[n]}
    </svg>
  );
}

/* ── Atoms ───────────────────────────────────────────────────────────────── */

function Eyebrow({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <div
      className="sc-fade"
      style={{
        animationDelay: `${delay}ms`,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.24em",
        color: "var(--meta)",
      }}
    >
      {children}
    </div>
  );
}

/** The one marketing line per scene — rvmp violet gradient, no serif. */
function Glint({
  children,
  delay,
  style,
}: {
  children: ReactNode;
  delay: number;
  style?: CSSProperties;
}) {
  return (
    <p
      className="sc-rise"
      style={{
        animationDelay: `${delay}ms`,
        margin: 0,
        fontSize: 20,
        fontWeight: 650,
        letterSpacing: "-0.01em",
        background: "linear-gradient(92deg, #d6c9ff 0%, #8b5cf6 70%)",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        filter: "drop-shadow(0 0 22px rgba(139,92,246,0.45))",
        ...style,
      }}
    >
      {children}
    </p>
  );
}

/** Typewriter — CSS clip reveal + riding caret. */
function Type({
  text,
  delay,
  dur = 1.6,
  caret = false,
  style,
}: {
  text: string;
  delay: number;
  dur?: number;
  caret?: boolean;
  style?: CSSProperties;
}) {
  const vars = { "--sc-type-dur": `${dur}s`, "--sc-type-delay": `${delay}s` } as CSSProperties;
  return (
    <span className="sc-type" style={style}>
      <span className="sc-type-clip" style={vars}>
        {text}
      </span>
      {caret ? <i aria-hidden className="sc-caret" style={vars} /> : null}
    </span>
  );
}

/** Clip reveal without a caret — lines "being written". */
function Reveal({
  children,
  delay,
  dur = 1.2,
  style,
}: {
  children: ReactNode;
  delay: number;
  dur?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      className="sc-reveal"
      style={{ "--sc-type-dur": `${dur}s`, "--sc-type-delay": `${delay}s`, ...style } as CSSProperties}
    >
      {children}
    </span>
  );
}

/** The app's badge grammar: mono, uppercase, tiny. */
function Badge({
  children,
  icon,
  color = "var(--meta)",
  bg = "var(--surface-2)",
  border = "var(--border)",
  style,
}: {
  children: ReactNode;
  icon?: string;
  color?: string;
  bg?: string;
  border?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        minHeight: 19,
        padding: "1px 7px",
        border: `1px solid ${border}`,
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 9.5,
        fontWeight: 650,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: ".45px",
        lineHeight: 1.2,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {icon ? <I n={icon} s={10} /> : null}
      {children}
    </span>
  );
}

const VIOLET_CHIP = { color: "#b7a6ff", bg: "rgba(109,40,217,0.22)", border: "rgba(139,92,246,0.45)" };
const GREEN_CHIP = { color: "var(--green)", bg: "rgba(63,185,80,0.12)", border: "rgba(63,185,80,0.4)" };
const AMBER_CHIP = { color: "var(--amber)", bg: "rgba(232,193,99,0.10)", border: "rgba(232,193,99,0.4)" };

/* ── The app window mock (sidebar + tabs, straight from the real board) ──── */

function Win({ tab, children }: { tab: "board" | "terminal" | "diff"; children: ReactNode }) {
  const tabs = [
    { id: "board", label: "Board 1" },
    { id: "terminal", label: "Terminal 2" },
    { id: "diff", label: "Diff 3" },
  ] as const;
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", background: "var(--bg)" }}>
      {/* Sidebar */}
      <div
        style={{
          width: 168,
          flexShrink: 0,
          borderRight: "1px solid var(--hairline)",
          padding: "10px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <div className="sc-fade" style={{ animationDelay: "200ms", display: "flex", alignItems: "center", gap: 7, padding: "2px 4px 10px" }}>
          <span
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              background: "#0e0d16",
              border: "1px solid var(--border)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, background: "#8b7cf6" }} />
          </span>
          <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: "-0.02em" }}>rvmp</span>
        </div>
        <div
          className="sc-fade"
          style={{ animationDelay: "300ms", fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", color: "var(--dim)", padding: "2px 4px" }}
        >
          PROJECTS
        </div>
        {["linkbox", "rvmp"].map((p, i) => (
          <div
            key={p}
            className="sc-rise-sm"
            style={{
              animationDelay: `${400 + i * 90}ms`,
              borderRadius: 7,
              padding: "6px 8px",
              background: i === 0 ? "var(--surface-2)" : "transparent",
              border: i === 0 ? "1px solid var(--border)" : "1px solid transparent",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>{p}</div>
            <div style={{ fontSize: 9.5, color: "var(--dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ~/Developer/{p === "linkbox" ? "codegent-demo" : "rvmp"}
            </div>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* Top bar */}
        <div
          className="sc-fade"
          style={{
            animationDelay: "250ms",
            height: 46,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1px solid var(--hairline)",
            padding: "0 14px",
          }}
        >
          <span style={{ fontWeight: 650, fontSize: 13 }}>linkbox</span>
          <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 9, padding: 2, gap: 2 }}>
            {tabs.map((t) => (
              <span
                key={t.id}
                style={{
                  padding: "3px 10px",
                  borderRadius: 7,
                  fontSize: 11,
                  fontWeight: 600,
                  background: tab === t.id ? "var(--violet)" : "transparent",
                  color: tab === t.id ? "#fff" : "var(--meta)",
                }}
              >
                {t.label}
              </span>
            ))}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", color: "var(--meta)" }}>
            <Badge icon="term">K palette</Badge>
          </span>
        </div>
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
}

/* ── Board bits ──────────────────────────────────────────────────────────── */

function Col({
  title,
  count,
  x,
  delay,
  headerExtra,
  children,
}: {
  title: string;
  count?: ReactNode;
  x: number;
  delay: number;
  headerExtra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className="sc-rise"
      style={{
        animationDelay: `${delay}ms`,
        position: "absolute",
        left: x,
        top: 16,
        width: 176,
        borderRadius: 10,
        border: "1px solid var(--hairline)",
        background: "rgba(230,237,243,0.015)",
        padding: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 8px" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--meta)" }}>
          {title}
        </span>
        {headerExtra}
        {count != null ? <Badge>{count}</Badge> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </div>
  );
}

function MiniCard({
  title,
  chips,
  delay,
  ghost,
  pulse,
  style,
}: {
  title: ReactNode;
  chips?: ReactNode;
  delay: number;
  ghost?: string;
  pulse?: string;
  style?: CSSProperties;
}) {
  const inner = (
    <div
      style={{
        position: "relative",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "9px 10px",
        ...style,
      }}
    >
      {pulse ? (
        <i aria-hidden className="sc-cardpulse" style={{ "--sc-cp-delay": pulse } as CSSProperties} />
      ) : null}
      <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.35 }}>{title}</div>
      {chips ? <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>{chips}</div> : null}
    </div>
  );
  return (
    <div className="sc-rise-sm" style={{ animationDelay: `${delay}ms` }}>
      {ghost ? (
        <div className="sc-ghost" style={{ "--sc-ghost-delay": ghost } as CSSProperties}>
          {inner}
        </div>
      ) : (
        inner
      )}
    </div>
  );
}

/** Landing card (appears where a flight ends). */
function LandedCard({
  title,
  chips,
  delay,
  pulse,
  style,
}: {
  title: ReactNode;
  chips?: ReactNode;
  delay: string;
  pulse?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="sc-pop-in"
      style={
        {
          "--sc-pop-delay": delay,
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          padding: "9px 10px",
          position: "relative",
          ...style,
        } as CSSProperties
      }
    >
      {pulse ? (
        <i aria-hidden className="sc-cardpulse" style={{ "--sc-cp-delay": pulse } as CSSProperties} />
      ) : null}
      <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.35 }}>{title}</div>
      {chips ? <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>{chips}</div> : null}
    </div>
  );
}

/* ── 00 · Genesis — every agent got its own window ───────────────────────── */

const TERMS = ["claude", "codex", "gemini", "goose", "aider", "amp"];

function TermChip({ name, style }: { name: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 7,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        boxShadow: "0 8px 24px -10px rgba(1,4,9,0.8)",
        padding: "6px 10px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-2)",
        ...style,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: "#8b7cf6", boxShadow: "0 0 6px rgba(139,92,246,0.8)" }} />
      $ {name}
    </span>
  );
}

/** The six agent terminals orbiting the board-shaped hole. In Genesis it
 *  orbits forever — the fusion only happens in One Board (collapseDelay).
 *  size-0 is load-bearing at EVERY level of the chain (wrapper → sc-orbit →
 *  positioner → sc-orbit-rev): a shrink-to-fit wrapper with an in-flow block
 *  child stretches to a nonzero box, which moves the (counter-)rotation
 *  origin off the orbit point and makes the ring wander off-center. */
function TermRing({
  instant = false,
  collapseDelay,
  guideGhostDelay,
}: {
  instant?: boolean;
  collapseDelay?: string;
  guideGhostDelay?: string;
}) {
  const guideCls = guideGhostDelay ? "sc-ghost" : instant ? undefined : "sc-fade";
  const guideStyle = (guideGhostDelay
    ? { "--sc-ghost-delay": guideGhostDelay }
    : { animationDelay: "1100ms" }) as CSSProperties;
  const dotStyle = (guideGhostDelay
    ? { "--sc-ghost-delay": guideGhostDelay }
    : { animationDelay: "1300ms" }) as CSSProperties;
  const ring = (
    <div className="sc-orbit" style={{ width: 0, height: 0, "--sc-orbit-dur": "30s" } as CSSProperties}>
      {TERMS.map((t, i) => {
        const a = i * (360 / TERMS.length) - 90;
        return (
          <span
            key={t}
            className="sc-pos"
            style={{
              position: "absolute",
              width: 0,
              height: 0,
              transform: `rotate(${a}deg) translate(200px) rotate(${-a}deg)`,
            }}
          >
            <span
              className="sc-orbit-rev"
              style={{ display: "flow-root", width: 0, height: 0, "--sc-orbit-dur": "30s" } as CSSProperties}
            >
              <span
                className={instant ? undefined : "sc-pop"}
                style={{
                  display: "block",
                  marginTop: -15,
                  marginLeft: -52,
                  animationDelay: instant ? undefined : `${700 + i * 260}ms`,
                }}
              >
                <TermChip name={t} style={{ width: 104, justifyContent: "flex-start" }} />
              </span>
            </span>
          </span>
        );
      })}
    </div>
  );
  return (
    <div style={{ position: "absolute", top: "52%", left: "50%", width: 0, height: 0 }}>
      {/* The board-shaped hole — five empty columns waiting for their agents. */}
      <div
        className={guideCls}
        style={{
          ...guideStyle,
          position: "absolute",
          left: -150,
          top: -100,
          width: 300,
          height: 200,
          borderRadius: 14,
          border: "1.5px dashed rgba(139,92,246,0.5)",
          display: "flex",
          padding: 10,
          gap: 8,
        }}
      >
        {[0, 1, 2, 3, 4].map((c) => (
          <span
            key={c}
            style={{
              flex: 1,
              borderRadius: 7,
              border: "1px dashed rgba(230,237,243,0.12)",
            }}
          />
        ))}
      </div>
      <span
        aria-hidden
        className={guideCls}
        style={{
          ...dotStyle,
          position: "absolute",
          left: -3,
          top: -3,
          width: 6,
          height: 6,
          borderRadius: 999,
          background: "#8b7cf6",
          boxShadow: "0 0 10px rgba(139,92,246,0.9)",
        }}
      />
      {collapseDelay ? (
        <div className="sc-collapse" style={{ width: 0, height: 0, "--sc-collapse-delay": collapseDelay } as CSSProperties}>
          {ring}
        </div>
      ) : (
        ring
      )}
    </div>
  );
}

const STAGE_BG =
  "radial-gradient(52% 42% at 50% 30%, rgba(139,92,246,0.10), transparent 70%), radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(1,4,9,0.5))";

function TitleWords({ text, delay, size = 32 }: { text: string; delay: number; size?: number }) {
  return (
    <h2
      style={{
        margin: 0,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        columnGap: "0.28em",
        padding: "0 40px",
        textAlign: "center",
        fontWeight: 700,
        fontSize: size,
        lineHeight: 1.15,
        letterSpacing: "-0.03em",
      }}
    >
      {text.split(" ").map((w, i) => (
        <span
          key={`${w}-${i}`}
          className="sc-rise"
          style={{ display: "inline-block", animationDelay: `${delay + i * 120}ms` }}
        >
          {w}
        </span>
      ))}
    </h2>
  );
}

function SceneGenesis() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, background: STAGE_BG, pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: 58, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Eyebrow delay={300}>CODEGENT.IO PRESENTS</Eyebrow>
        <div style={{ marginTop: 12 }}>
          <TitleWords text="Every agent got its own little window." delay={650} size={32} />
        </div>
      </div>
      <TermRing />
      <Glint delay={4200} style={{ position: "absolute", bottom: 88, left: "50%", transform: "translateX(-50%)" }}>
        one board would do.
      </Glint>
      <div
        className="sc-fade"
        style={{
          animationDelay: "5600ms",
          position: "absolute",
          bottom: 26,
          left: "50%",
          transform: "translateX(-50%)",
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.2em",
          color: "var(--dim)",
        }}
      >
        SPACE — PAUSE · ← → — SCENES · F — FULLSCREEN
      </div>
    </div>
  );
}

/* ── 01 · One board — the fusion, then the wordmark ──────────────────────── */

function MiniBoard({ delay }: { delay: number }) {
  const cols: { bars: { w: string; c: string }[] }[] = [
    { bars: [{ w: "86%", c: "var(--surface-2)" }, { w: "64%", c: "var(--surface-2)" }] },
    { bars: [{ w: "92%", c: "rgba(139,92,246,0.5)" }] },
    { bars: [{ w: "78%", c: "rgba(232,193,99,0.5)" }] },
    { bars: [{ w: "70%", c: "var(--surface-2)" }, { w: "88%", c: "rgba(63,185,80,0.45)" }] },
    { bars: [{ w: "82%", c: "rgba(63,185,80,0.35)" }] },
  ];
  return (
    <div
      className="sc-pop"
      style={{
        animationDelay: `${delay}ms`,
        position: "relative",
        width: 380,
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "var(--bg)",
        boxShadow: "0 30px 80px -30px rgba(1,4,9,0.9), 0 0 60px -18px rgba(139,92,246,0.5)",
        padding: 10,
        display: "flex",
        gap: 7,
      }}
    >
      <i
        aria-hidden
        className="sc-ringpulse"
        style={{ "--sc-rp-delay": `${delay / 1000 + 0.35}s`, "--sc-rp-times": "2", borderRadius: 14 } as CSSProperties}
      />
      {cols.map((c, ci) => (
        <div key={ci} style={{ flex: 1, borderRadius: 8, border: "1px solid var(--hairline)", padding: 5, display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ height: 3, borderRadius: 2, background: "var(--border)", width: "55%" }} />
          {c.bars.map((b, bi) => (
            <span key={bi} style={{ height: 12, borderRadius: 4, background: b.c, width: b.w }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function SceneIgnition() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div className="sc-shake" style={{ position: "absolute", inset: 0, "--sc-shake-delay": "1.2s" } as CSSProperties}>
        <div aria-hidden style={{ position: "absolute", inset: 0, background: STAGE_BG, pointerEvents: "none" }} />
        <TermRing instant collapseDelay="0.5s" guideGhostDelay="0.5s" />
        <span
          aria-hidden
          className="sc-flash"
          style={{ top: "52%", left: "50%", marginTop: -300, marginLeft: -300, width: 600, height: 600, "--sc-flash-delay": "1.2s" } as CSSProperties}
        />
        <span
          aria-hidden
          className="sc-sweep"
          style={{ top: "52%", left: "8%", right: "8%", "--sc-sweep-delay": "1.3s", "--sc-sweep-dur": "1.6s" } as CSSProperties}
        />
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 0 }}>
          <MiniBoard delay={2000} />
          <h1
            className="sc-rise"
            style={{ animationDelay: "2700ms", margin: "26px 0 0", fontSize: 64, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1 }}
          >
            rvmp
          </h1>
          <p className="sc-rise" style={{ animationDelay: "3300ms", margin: "12px 0 0", fontSize: 14, color: "var(--text-2)" }}>
            Your coding agents, on a board.
          </p>
          <div className="sc-fade" style={{ animationDelay: "4200ms", marginTop: 14, display: "flex", gap: 6 }}>
            <Badge>every agent</Badge>
            <Badge>one board</Badge>
            <Badge>your hardware</Badge>
          </div>
          <Glint delay={6000} style={{ marginTop: 26 }}>
            access from anywhere.
          </Glint>
        </div>
      </div>
    </div>
  );
}

/* ── 02 · The board — attention, routed ──────────────────────────────────── */

const HERO_TITLE = "Add a --version flag to the linkbox CLI";

function SceneBoard() {
  return (
    <Win tab="board">
      {/* Columns — absolutely placed so flight math stays honest. */}
      <Col title="QUEUE" count="1" x={16} delay={400}>
        <MiniCard
          title={HERO_TITLE}
          delay={900}
          ghost="2.5s"
          chips={
            <>
              <Badge>queue · 1</Badge>
              <Badge {...VIOLET_CHIP}>claude</Badge>
            </>
          }
        />
        <MiniCard
          title="Fix flaky auth test in CI"
          delay={1050}
          chips={
            <>
              <Badge>queue · 2</Badge>
              <Badge {...VIOLET_CHIP}>codex</Badge>
            </>
          }
        />
      </Col>
      <Col
        title="RUNNING"
        x={202}
        delay={500}
        headerExtra={
          <span className="sc-pop-in" style={{ "--sc-pop-delay": "3.9s" } as CSSProperties}>
            <Badge {...VIOLET_CHIP}>1/2</Badge>
          </span>
        }
      >
        <div className="sc-ghost" style={{ "--sc-ghost-delay": "6.5s" } as CSSProperties}>
          <LandedCard
            title={HERO_TITLE}
            delay="3.85s"
            chips={
              <>
                <Badge {...GREEN_CHIP}>running · 2s</Badge>
                <Badge {...VIOLET_CHIP}>claude</Badge>
              </>
            }
          />
        </div>
      </Col>
      <Col
        title="WAITING FOR INPUT"
        x={388}
        delay={600}
        count={
          <span style={{ position: "relative", display: "inline-flex" }}>
            <Badge style={{ visibility: "hidden" }}>1</Badge>
            <span className="sc-pop-in" style={{ "--sc-pop-delay": "7.9s", position: "absolute", inset: 0 } as CSSProperties}>
              <Badge {...AMBER_CHIP}>1</Badge>
            </span>
          </span>
        }
      >
        <LandedCard
          title={HERO_TITLE}
          delay="7.85s"
          pulse="7.95s"
          chips={
            <>
              <Badge {...AMBER_CHIP} icon="question">
                question · 1m
              </Badge>
              <Badge {...VIOLET_CHIP}>claude</Badge>
            </>
          }
        />
      </Col>
      <Col title="IN REVIEW" count="2" x={574} delay={700}>
        <MiniCard
          title="Refactor link parser into its own module"
          delay={1150}
          chips={
            <>
              <Badge {...GREEN_CHIP} icon="check">
                ready for review
              </Badge>
              <Badge {...VIOLET_CHIP}>claude</Badge>
            </>
          }
        />
        <MiniCard
          title="Add OpenGraph preview cards"
          delay={1300}
          chips={
            <>
              <Badge>round 2</Badge>
              <Badge {...VIOLET_CHIP}>codex</Badge>
            </>
          }
        />
      </Col>
      <Col title="DONE" count="2" x={760} delay={800}>
        <MiniCard
          title={<span style={{ textDecoration: "line-through", opacity: 0.6 }}>Set up Bun test harness</span>}
          delay={1450}
          chips={
            <>
              <Badge {...GREEN_CHIP} icon="check">
                done
              </Badge>
              <Badge {...VIOLET_CHIP}>claude</Badge>
            </>
          }
        />
        <MiniCard
          title={<span style={{ textDecoration: "line-through", opacity: 0.6 }}>Ship v0.2.0 changelog</span>}
          delay={1600}
          chips={
            <>
              <Badge {...GREEN_CHIP} icon="check">
                done
              </Badge>
              <Badge {...VIOLET_CHIP}>codex</Badge>
            </>
          }
        />
      </Col>

      {/* Flight A — queue → running (auto-start within the worker limit). */}
      <div
        aria-hidden
        className="sc-fly"
        style={
          {
            left: 26,
            top: 62,
            width: 156,
            "--fx": "186px",
            "--fy": "0px",
            "--fa": "60px",
            "--fly-del": "2.5s",
            "--fly-dur": "1.35s",
          } as CSSProperties
        }
      >
        <div style={{ borderRadius: 8, border: "1px solid rgba(139,92,246,0.5)", background: "var(--surface-2)", padding: "9px 10px", boxShadow: "0 18px 44px -12px rgba(1,4,9,0.85), 0 0 26px -8px rgba(139,92,246,0.55)" }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.3 }}>{HERO_TITLE}</div>
        </div>
      </div>
      {/* Flight B — running → waiting for input (the agent asked a question). */}
      <div
        aria-hidden
        className="sc-fly"
        style={
          {
            left: 212,
            top: 62,
            width: 156,
            "--fx": "186px",
            "--fy": "0px",
            "--fa": "60px",
            "--fly-del": "6.5s",
            "--fly-dur": "1.35s",
          } as CSSProperties
        }
      >
        <div style={{ borderRadius: 8, border: "1px solid rgba(232,193,99,0.55)", background: "var(--surface-2)", padding: "9px 10px", boxShadow: "0 18px 44px -12px rgba(1,4,9,0.85), 0 0 26px -8px rgba(232,193,99,0.5)" }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.3 }}>{HERO_TITLE}</div>
        </div>
      </div>

      <Glint delay={9200} style={{ position: "absolute", bottom: 20, left: 24 }}>
        it tells you where to look.
      </Glint>
    </Win>
  );
}

/* ── 03 · Terminals — the conversation lives in the PTY ──────────────────── */

function TermLine({ children, delay, dur = 1, color }: { children: ReactNode; delay: number; dur?: number; color?: string }) {
  return (
    <div style={{ color: color ?? "var(--text-2)", whiteSpace: "pre-wrap" }}>
      <Reveal delay={delay} dur={dur} style={{ display: "inline" }}>
        {children}
      </Reveal>
    </div>
  );
}

function SceneTerminal() {
  return (
    <Win tab="terminal">
      <div style={{ position: "absolute", inset: 0, display: "flex" }}>
        {/* Session rail */}
        <div style={{ width: 190, flexShrink: 0, borderRight: "1px solid var(--hairline)", padding: 10 }}>
          <div className="sc-fade" style={{ animationDelay: "350ms", fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", color: "var(--dim)", padding: "2px 4px 6px" }}>
            SESSIONS
          </div>
          <div
            className="sc-rise-sm"
            style={{ animationDelay: "500ms", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface-2)", padding: "7px 8px" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--amber)", boxShadow: "0 0 6px rgba(232,193,99,0.8)" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✳ Add a --version flag to t…</span>
            </div>
            <div style={{ marginTop: 3, fontSize: 9.5, color: "var(--amber)", fontFamily: "var(--font-mono)" }}>claude · waiting · 1m</div>
          </div>
          <div className="sc-rise-sm" style={{ animationDelay: "620ms", marginTop: 6, borderRadius: 7, border: "1px dashed var(--border)", padding: "7px 8px", fontSize: 11, color: "var(--dim)" }}>
            + terminal · main
          </div>
        </div>

        {/* The PTY — a real Claude Code TUI, faithfully mocked. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "#0b0e14" }}>
          <div style={{ flex: 1, padding: "14px 16px", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.95, overflow: "hidden" }}>
            <TermLine delay={1.0} color="var(--text)">
              <span style={{ color: "#8b7cf6" }}>●</span> Done. I added a --version flag (with -v alias) to the linkbox CLI:
            </TermLine>
            <TermLine delay={1.7}>
              {"  - src/cli.ts imports the version and prints it when invoked with --version or -v."}
            </TermLine>
            <TermLine delay={2.5}>
              <span style={{ color: "#8b7cf6" }}>●</span> Baked for 46s
            </TermLine>

            {/* The question — the reason the card went amber. */}
            <div
              className="sc-pop-in"
              style={
                {
                  "--sc-pop-delay": "3.4s",
                  marginTop: 8,
                  borderRadius: 8,
                  border: "1px solid rgba(232,193,99,0.45)",
                  background: "rgba(232,193,99,0.06)",
                  padding: "8px 10px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                } as CSSProperties
              }
            >
              <I n="question" s={13} style={{ color: "var(--amber)", flexShrink: 0 }} />
              <span style={{ color: "var(--text)" }}>Also print the Bun runtime version? (y/N)</span>
            </div>

            {/* You answer — in the terminal, where the question lives. */}
            <div style={{ marginTop: 6, color: "var(--text)" }}>
              <span style={{ color: "#8b7cf6" }}>▸ </span>
              <Type text="y" delay={5.2} dur={0.4} caret />
            </div>

            <TermLine delay={6.4}>
              <span style={{ color: "#8b7cf6" }}>●</span> The line note asks to also print the Bun runtime version.
            </TermLine>
            <TermLine delay={7.2} color="var(--text)">
              ● Update(src/cli.ts)
            </TermLine>
            <TermLine delay={7.7} color="var(--git-red)">
              {"  -   console.log(pkg.version);"}
            </TermLine>
            <TermLine delay={8.1} color="var(--git-green)">
              {"  +   console.log(`linkbox ${pkg.version} (bun ${Bun.version})`);"}
            </TermLine>
            <TermLine delay={8.9} color="var(--green)">
              ✓ task_complete — card moves to review
            </TermLine>
          </div>

          {/* TUI status bar */}
          <div
            className="sc-fade"
            style={{
              animationDelay: "1200ms",
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderTop: "1px solid var(--hairline)",
              padding: "7px 14px",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--amber-dim, #9d8b4a)",
            }}
          >
            ▸▸ auto mode on (shift+tab to cycle) · esc to interrupt
            <span className="sc-pop-in" style={{ "--sc-pop-delay": "9.6s", marginLeft: "auto" } as CSSProperties}>
              <Badge {...VIOLET_CHIP}>scrollback survives restarts</Badge>
            </span>
          </div>
        </div>
      </div>

      <Glint delay={10200} style={{ position: "absolute", bottom: 18, left: 214 }}>
        conversation happens where it belongs.
      </Glint>
    </Win>
  );
}

/* ── 04 · Detection — state without surveillance ─────────────────────────── */

const SIGNALS: { name: string; sub: string; angle: number; del: number }[] = [
  { name: "process tree", sub: "identity, not text", angle: -35, del: 1.6 },
  { name: "OSC codes", sub: "title + progress", angle: 35, del: 2.5 },
  { name: "screen manifests", sub: "regions, not content", angle: 145, del: 3.4 },
  { name: "MCP task_complete", sub: "the agent declares done", angle: 215, del: 4.3 },
];

function SceneDetection() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, background: STAGE_BG, pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: 52, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Eyebrow delay={300}>THE PART NOBODY ELSE DOES</Eyebrow>
        <div style={{ marginTop: 12 }}>
          <TitleWords text="It knows. Without reading a word." delay={550} size={34} />
        </div>
      </div>

      <div style={{ position: "absolute", top: "56%", left: "50%" }}>
        {/* Spokes + signal chips */}
        {SIGNALS.map((s, i) => (
          <span
            key={`spoke-${s.name}`}
            aria-hidden
            className="sc-spoke"
            style={{ top: 0, left: 0, width: 220, "--rot": `${s.angle}deg`, "--sc-spoke-delay": `${s.del + 0.25}s` } as CSSProperties}
          />
        ))}
        <div aria-hidden className="sc-stream">
          {SIGNALS.map((s, i) => {
            const rad = (s.angle * Math.PI) / 180;
            const tx = Math.cos(rad) * 220;
            const ty = Math.sin(rad) * 220;
            return (
              <i
                key={`st-${s.name}`}
                style={
                  {
                    left: 0,
                    top: 0,
                    "--tx": `${tx}px`,
                    "--ty": `${ty}px`,
                    "--st-del": `${s.del + 0.6}s`,
                    "--st-dur": "2.4s",
                  } as CSSProperties
                }
              />
            );
          })}
        </div>

        {/* The state badge — flips when the signals agree. */}
        <div
          className="sc-pop"
          style={{
            animationDelay: "1000ms",
            position: "absolute",
            left: -105,
            top: -34,
            width: 210,
            height: 68,
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 50px -14px rgba(139,92,246,0.55)",
          }}
        >
          <span className="sc-ghost" style={{ "--sc-ghost-delay": "5.8s", position: "absolute" } as CSSProperties}>
            <Badge {...VIOLET_CHIP} style={{ fontSize: 11, padding: "4px 12px" }}>
              working
            </Badge>
          </span>
          <span className="sc-pop-in" style={{ "--sc-pop-delay": "5.9s", position: "absolute" } as CSSProperties}>
            <Badge {...AMBER_CHIP} icon="question" style={{ fontSize: 11, padding: "4px 12px" }}>
              waiting for input
            </Badge>
          </span>
          <i aria-hidden className="sc-ringpulse" style={{ "--sc-rp-delay": "5.9s", "--sc-rp-times": "2", borderRadius: 12 } as CSSProperties} />
        </div>

        {SIGNALS.map((s) => (
          <div
            key={s.name}
            className="sc-pop"
            style={{
              animationDelay: `${s.del * 1000}ms`,
              position: "absolute",
              left: -92,
              top: -25,
              width: 184,
              transform: `rotate(${s.angle}deg) translate(220px) rotate(${-s.angle}deg)`,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              padding: "8px 12px",
            }}
          >
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>{s.name}</div>
            <div style={{ fontSize: 10, color: "var(--meta)" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* The principle. */}
      <div style={{ position: "absolute", bottom: 96, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <div className="sc-fade" style={{ animationDelay: "6600ms", fontSize: 14, color: "var(--text-2)" }}>
          <span className="sc-strike" style={{ "--sc-strike-delay": "7.2s" } as CSSProperties}>
            terminal content
          </span>
        </div>
        <span className="sc-pop-in" style={{ "--sc-pop-delay": "7.7s" } as CSSProperties}>
          <Badge {...GREEN_CHIP} icon="lock" style={{ fontSize: 10.5, padding: "3px 11px" }}>
            never leaves the terminal
          </Badge>
        </span>
        <Glint delay={8600}>state, not surveillance.</Glint>
      </div>
    </div>
  );
}

/* ── 05 · Review — real diffs, queued comments ───────────────────────────── */

const DIFF_LINES: { t: string; kind: "ctx" | "min" | "plus" | "hunk" }[] = [
  { t: "@@ -7,8 +7,11 @@ const [cmd, arg] = process.argv.slice(2);", kind: "hunk" },
  { t: '   7  7    if (cmd === "--version" || cmd === "-v") {', kind: "ctx" },
  { t: "-  8       console.log(pkg.version);", kind: "min" },
  { t: "+  8       console.log(`linkbox ${pkg.version}`);", kind: "plus" },
  { t: "+  9       // Bun runtime included on request — see review", kind: "plus" },
  { t: "  10 10    } else if (cmd === \"build\") {", kind: "ctx" },
  { t: "  11 11      const cfg = loadConfig(arg ?? \"links.json\");", kind: "ctx" },
];

function SceneReview() {
  return (
    <Win tab="diff">
      {/* Review header */}
      <div
        className="sc-fade"
        style={{ animationDelay: "350ms", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--hairline)" }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-2)", padding: "4px 11px", fontSize: 11.5, fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--green)" }} />
          Add a --version flag to the linkbox CLI
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--git-green)" }}>+5</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--git-red)" }}>−2</span>
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, padding: 2, gap: 2, fontSize: 10.5 }}>
            <span style={{ padding: "2px 8px", borderRadius: 6, background: "var(--violet)", color: "#fff", fontWeight: 600 }}>Unified</span>
            <span style={{ padding: "2px 8px", color: "var(--meta)" }}>Split</span>
          </span>
          <span className="sc-pop-in" style={{ "--sc-pop-delay": "8.2s" } as CSSProperties}>
            <Badge {...VIOLET_CHIP} icon="send" style={{ fontSize: 10.5, padding: "4px 11px" }}>
              send back · 1
            </Badge>
          </span>
          <Badge icon="git">open pr</Badge>
          <Badge {...GREEN_CHIP} icon="merge">merge ▾</Badge>
        </span>
      </div>

      <div style={{ display: "flex", position: "absolute", inset: "47px 0 0 0" }}>
        {/* Files panel */}
        <div style={{ width: 190, flexShrink: 0, borderRight: "1px solid var(--hairline)", padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 8px", position: "relative" }}>
            <span className="sc-ghost" style={{ "--sc-ghost-delay": "3.2s", fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--dim)" } as CSSProperties}>
              FILES 0/1 REVIEWED
            </span>
            <span className="sc-pop-in" style={{ "--sc-pop-delay": "3.2s", position: "absolute", left: -2, top: -3 } as CSSProperties}>
              <Badge {...GREEN_CHIP} icon="check">1/1 reviewed</Badge>
            </span>
          </div>
          <div
            className="sc-rise-sm"
            style={{ animationDelay: "600ms", display: "flex", alignItems: "center", gap: 7, borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface-2)", padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 10.5 }}
          >
            <span style={{ color: "var(--amber)" }}>M</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>src/cli.ts</span>
            <span style={{ color: "var(--git-green)" }}>+5</span>
            <span style={{ color: "var(--git-red)" }}>−2</span>
            <span style={{ position: "relative", width: 13, height: 13, borderRadius: 4, border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              <I n="check" s={10} style={{ color: "var(--green)" }} />
            </span>
          </div>
        </div>

        {/* Diff */}
        <div style={{ flex: 1, minWidth: 0, padding: "10px 14px", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.85, position: "relative" }}>
          <div style={{ color: "var(--text)", fontWeight: 600, marginBottom: 4 }}>
            src/cli.ts <span style={{ color: "var(--git-green)", fontWeight: 400 }}>+5</span> <span style={{ color: "var(--git-red)", fontWeight: 400 }}>−2</span>
          </div>
          {DIFF_LINES.map((l, i) => (
            <div
              key={i}
              className="sc-fade"
              style={{
                animationDelay: `${700 + i * 130}ms`,
                whiteSpace: "pre",
                borderRadius: 3,
                paddingLeft: 6,
                color: l.kind === "min" ? "#ffa198" : l.kind === "plus" ? "#7ee2a8" : l.kind === "hunk" ? "var(--cyan)" : "var(--text-2)",
                background: l.kind === "min" ? "rgba(248,81,73,0.10)" : l.kind === "plus" ? "rgba(63,185,80,0.10)" : "transparent",
                position: "relative",
              }}
            >
              {l.t}
              {l.kind === "plus" && i === 3 ? (
                <span
                  className="sc-pop-in"
                  style={{ "--sc-pop-delay": "5s", position: "absolute", right: 6, top: 2, color: "var(--violet-2)" } as CSSProperties}
                >
                  <I n="plus" s={12} />
                </span>
              ) : null}
            </div>
          ))}

          {/* The comment editor — opens on the green line, ghosts when queued. */}
          <div className="sc-ghost" style={{ "--sc-ghost-delay": "8.1s" } as CSSProperties}>
            <div
              className="sc-pop-in"
              style={
                {
                  "--sc-pop-delay": "5.6s",
                  marginTop: 8,
                  marginLeft: 6,
                  width: 420,
                  borderRadius: 8,
                  border: "1px solid rgba(139,92,246,0.5)",
                  background: "var(--surface)",
                  padding: "8px 10px",
                  boxShadow: "0 12px 36px -12px rgba(1,4,9,0.85)",
                } as CSSProperties
              }
            >
              <div style={{ fontSize: 11, color: "var(--text)" }}>
                <Type text="nice — also print the Bun runtime version" delay={6.0} dur={1.5} caret />
              </div>
              <div style={{ marginTop: 7, display: "flex", gap: 6 }}>
                <Badge {...VIOLET_CHIP}>queue comment</Badge>
                <Badge>cancel</Badge>
              </div>
            </div>
          </div>

          {/* The queued comment — pinned to the line, waiting for the batch. */}
          <div
            className="sc-pop-in"
            style={
              {
                "--sc-pop-delay": "8.2s",
                marginTop: 8,
                marginLeft: 6,
                width: 420,
                borderRadius: 8,
                border: "1px solid rgba(139,92,246,0.55)",
                background: "rgba(109,40,217,0.12)",
                padding: "8px 10px",
              } as CSSProperties
            }
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
              <I n="file" s={11} style={{ color: "#b7a6ff" }} />
              <span style={{ flex: 1, color: "var(--text)" }}>nice — also print the Bun runtime version</span>
              <Badge {...VIOLET_CHIP}>queued</Badge>
              <span style={{ color: "var(--meta)", fontSize: 10 }}>edit · delete</span>
            </div>
          </div>
        </div>
      </div>

      {/* Send-back flight — the card returns to the agent with the batch. */}
      <div
        aria-hidden
        className="sc-fly"
        style={
          {
            right: 24,
            top: 8,
            width: 130,
            "--fx": "-640px",
            "--fy": "420px",
            "--fa": "80px",
            "--fly-del": "9.8s",
            "--fly-dur": "1.3s",
          } as CSSProperties
        }
      >
        <div style={{ borderRadius: 8, border: "1px solid rgba(139,92,246,0.55)", background: "var(--surface-2)", padding: "8px 10px", boxShadow: "0 18px 44px -12px rgba(1,4,9,0.85), 0 0 26px -8px rgba(139,92,246,0.55)" }}>
          <div style={{ fontSize: 10.5, fontWeight: 600 }}>send back · 1 comment</div>
          <div style={{ marginTop: 4 }}><Badge {...VIOLET_CHIP}>round 2</Badge></div>
        </div>
      </div>

      <Glint delay={11400} style={{ position: "absolute", bottom: 16, left: 24 }}>
        real diffs. real comments. one batch.
      </Glint>
    </Win>
  );
}

/* ── 06 · Merge — round trips, then the green button ─────────────────────── */

function SceneMerge() {
  return (
    <Win tab="board">
      <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", gap: 14, paddingTop: 26 }}>
        {/* IN REVIEW */}
        <div className="sc-rise" style={{ animationDelay: "400ms", width: 250, borderRadius: 10, border: "1px solid var(--hairline)", background: "rgba(230,237,243,0.015)", padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 10px" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--meta)" }}>IN REVIEW</span>
            <Badge>1</Badge>
          </div>
          <div className="sc-ghost" style={{ "--sc-ghost-delay": "5s" } as CSSProperties}>
            <div style={{ position: "relative", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", padding: "10px 11px" }}>
              <i aria-hidden className="sc-cardpulse" style={{ "--sc-cp-delay": "3s", borderRadius: 8 } as CSSProperties} />
              <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.35 }}>Add a --version flag to the linkbox CLI</div>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
                <Badge>round 2</Badge>
                <Badge {...GREEN_CHIP} icon="check">ready for review</Badge>
                <Badge {...VIOLET_CHIP}>claude</Badge>
              </div>
              <div className="sc-pop-in" style={{ "--sc-pop-delay": "1.6s", marginTop: 8 } as CSSProperties}>
                <Badge color="var(--cyan)" bg="rgba(34,211,238,0.08)" border="rgba(34,211,238,0.35)" icon="check">
                  base moved — diff still clean
                </Badge>
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 6, position: "relative" }}>
                <Badge {...GREEN_CHIP} icon="merge" style={{ fontSize: 10.5, padding: "4px 11px" }}>merge ▾</Badge>
                <Badge icon="send">send back</Badge>
                {/* The merge menu */}
                <div
                  className="sc-pop-in"
                  style={
                    {
                      "--sc-pop-delay": "3.8s",
                      position: "absolute",
                      top: 26,
                      left: 0,
                      width: 168,
                      borderRadius: 9,
                      border: "1px solid var(--border)",
                      background: "var(--surface-2)",
                      boxShadow: "0 18px 44px -12px rgba(1,4,9,0.9)",
                      padding: 4,
                      zIndex: 20,
                    } as CSSProperties
                  }
                >
                  <div className="sc-ghost" style={{ "--sc-ghost-delay": "4.6s" } as CSSProperties}>
                    {["squash merge", "merge commit", "rebase merge"].map((m, i) => (
                      <div
                        key={m}
                        style={{
                          borderRadius: 6,
                          padding: "5px 8px",
                          fontSize: 11,
                          background: i === 0 ? "rgba(63,185,80,0.14)" : "transparent",
                          color: i === 0 ? "var(--green)" : "var(--text-2)",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {i === 0 ? <I n="check" s={10} /> : null}
                        {m}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* DONE */}
        <div className="sc-rise" style={{ animationDelay: "550ms", width: 250, borderRadius: 10, border: "1px solid var(--hairline)", background: "rgba(230,237,243,0.015)", padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px 10px", position: "relative" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--meta)" }}>DONE</span>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <Badge>1</Badge>
              <span className="sc-pop-in" style={{ "--sc-pop-delay": "6.6s", position: "absolute", inset: 0 } as CSSProperties}>
                <Badge {...GREEN_CHIP}>2</Badge>
              </span>
            </span>
          </div>
          <MiniCard
            title={<span style={{ textDecoration: "line-through", opacity: 0.6 }}>Set up Bun test harness</span>}
            delay={900}
            chips={<Badge {...GREEN_CHIP} icon="check">done</Badge>}
          />
          <div style={{ height: 8 }} />
          <LandedCard
            title="Add a --version flag to the linkbox CLI"
            delay="6.5s"
            chips={
              <>
                <Badge {...GREEN_CHIP} icon="check">done · squash</Badge>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--dim)" }}>f286bdd</span>
              </>
            }
          />
          <div
            className="sc-pop-in"
            style={{ "--sc-pop-delay": "7.5s", marginTop: 8, position: "relative" } as CSSProperties}
          >
            <Badge {...VIOLET_CHIP} icon="git" style={{ fontSize: 10, padding: "3px 10px" }}>
              pr #214 · ✓ checks pass
            </Badge>
            <span aria-hidden className="sc-confetti">
              {[
                { dx: "-54px", dy: "-46px", rr: "200deg", c: "#8b5cf6" },
                { dx: "-20px", dy: "-62px", rr: "-160deg", c: "#7ee2a8" },
                { dx: "16px", dy: "-66px", rr: "240deg", c: "#e8c163" },
                { dx: "48px", dy: "-44px", rr: "-220deg", c: "#22d3ee" },
                { dx: "60px", dy: "-10px", rr: "180deg", c: "#8b5cf6" },
                { dx: "-60px", dy: "-6px", rr: "-240deg", c: "#e6edf3" },
              ].map((p, i) => (
                <i key={i} style={{ "--dx": p.dx, "--dy": p.dy, "--rr": p.rr, "--c": p.c, "--sc-confetti-delay": "7.6s" } as CSSProperties} />
              ))}
            </span>
          </div>
        </div>
      </div>

      {/* The merge flight — review → done. */}
      <div
        aria-hidden
        className="sc-fly"
        style={
          {
            left: 332,
            top: 62,
            width: 228,
            "--fx": "264px",
            "--fy": "10px",
            "--fa": "56px",
            "--fly-del": "5s",
            "--fly-dur": "1.5s",
          } as CSSProperties
        }
      >
        <div style={{ borderRadius: 8, border: "1px solid rgba(63,185,80,0.55)", background: "var(--surface-2)", padding: "10px 11px", boxShadow: "0 18px 44px -12px rgba(1,4,9,0.85), 0 0 26px -8px rgba(63,185,80,0.5)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.35 }}>Add a --version flag to the linkbox CLI</div>
          <div style={{ marginTop: 8 }}><Badge {...GREEN_CHIP} icon="merge">squash merge</Badge></div>
        </div>
      </div>

      <Glint delay={8400} style={{ position: "absolute", bottom: 18, left: 24 }}>
        squash, merge, rebase — your call.
      </Glint>
    </Win>
  );
}

/* ── 07 · Agents — every agent, two tiers ────────────────────────────────── */

function TierCard({
  title,
  tone,
  delay,
  children,
  foot,
}: {
  title: string;
  tone: "violet" | "plain";
  delay: number;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div
      className="sc-rise"
      style={{
        animationDelay: `${delay}ms`,
        width: 300,
        borderRadius: 12,
        border: tone === "violet" ? "1px solid rgba(139,92,246,0.5)" : "1px solid var(--border)",
        background: "var(--surface)",
        boxShadow: tone === "violet" ? "0 0 44px -14px rgba(139,92,246,0.55)" : "none",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.14em", color: tone === "violet" ? "#b7a6ff" : "var(--meta)" }}>
        {title}
      </div>
      {children}
      {foot ? <div style={{ marginTop: "auto", paddingTop: 6 }}>{foot}</div> : null}
    </div>
  );
}

function AgentRow({ name, sub, delay }: { name: string; sub: string; delay: number }) {
  return (
    <div className="sc-rise-sm" style={{ animationDelay: `${delay}ms`, display: "flex", alignItems: "center", gap: 9 }}>
      <span style={{ width: 24, height: 24, borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "#b7a6ff" }}>
        {name[0]!.toUpperCase()}
      </span>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</div>
        <div style={{ fontSize: 10, color: "var(--meta)" }}>{sub}</div>
      </div>
    </div>
  );
}

function SceneAgents() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, background: STAGE_BG, pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: 46, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Eyebrow delay={300}>AGENTS</Eyebrow>
        <div style={{ marginTop: 12 }}>
          <TitleWords text="Every agent. Two tiers. Yours included." delay={550} size={32} />
        </div>
      </div>

      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 16, paddingTop: 90 }}>
        <TierCard title="PREMIUM" tone="violet" delay={1000} foot={<Badge {...VIOLET_CHIP}>deepest integration</Badge>}>
          <AgentRow name="Claude Code" sub="native hooks + MCP task tools" delay={1250} />
          <AgentRow name="Codex" sub="official hooks + MCP task tools" delay={1400} />
        </TierCard>

        <TierCard title="UNIVERSAL" tone="plain" delay={1750} foot={<Badge>content-free detection</Badge>}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {["Gemini CLI", "Goose", "OpenCode", "Aider", "Amp"].map((a, i) => (
              <span key={a} className="sc-pop" style={{ animationDelay: `${2000 + i * 140}ms` } as CSSProperties}>
                <Badge>{a}</Badge>
              </span>
            ))}
          </div>
          <div className="sc-fade" style={{ animationDelay: "2800ms", fontSize: 10.5, color: "var(--meta)" }}>
            anything recognizable — detection manifests
          </div>
        </TierCard>

        <TierCard title="+ YOURS" tone="plain" delay={3100} foot={
          <span className="sc-pop-in" style={{ "--sc-pop-delay": "7.2s" } as CSSProperties}>
            <Badge {...GREEN_CHIP} icon="check">one TOML manifest — no core PR</Badge>
          </span>
        }>
          <div style={{ borderRadius: 8, border: "1px solid var(--hairline)", background: "#0b0e14", padding: "9px 11px", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.9 }}>
            <div style={{ color: "var(--cyan)" }}>
              <Reveal delay={3.9} dur={0.6}>{"[agent]"}</Reveal>
            </div>
            <div style={{ color: "var(--text-2)" }}>
              <Reveal delay={4.6} dur={0.7}>{'name = "my-cli"'}</Reveal>
            </div>
            <div style={{ color: "var(--text-2)" }}>
              <Reveal delay={5.4} dur={0.7}>{'prompt = "❯"'}</Reveal>
            </div>
            <div style={{ color: "var(--text-2)" }}>
              <Reveal delay={6.2} dur={0.8}>{'done = "task_complete"'}</Reveal>
            </div>
          </div>
        </TierCard>
      </div>

      <Glint delay={8300} style={{ position: "absolute", bottom: 40, left: "50%", transform: "translateX(-50%)" }}>
        bring your own mind.
      </Glint>
    </div>
  );
}

/* ── 08 · Anywhere — your hardware, any browser ──────────────────────────── */

function PhoneBoard() {
  return (
    <div
      style={{
        width: 212,
        height: 384,
        borderRadius: 30,
        border: "2px solid var(--border)",
        background: "var(--bg)",
        boxShadow: "0 30px 80px -24px rgba(1,4,9,0.9), 0 0 50px -16px rgba(139,92,246,0.5)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        position: "relative",
      }}
    >
      <span style={{ alignSelf: "center", width: 56, height: 5, borderRadius: 999, background: "var(--border)" }} />
      <div style={{ display: "flex", gap: 4 }}>
        {["Board", "Term", "Diff"].map((t, i) => (
          <span key={t} style={{ padding: "2px 8px", borderRadius: 6, fontSize: 9, fontWeight: 600, background: i === 1 ? "var(--violet)" : "var(--surface-2)", color: i === 1 ? "#fff" : "var(--meta)" }}>
            {t}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>
          <Badge {...AMBER_CHIP}>1 waiting</Badge>
        </span>
      </div>
      {[
        { t: "Add a --version flag…", c: AMBER_CHIP, l: "question · 1m" },
        { t: "Refactor link parser…", c: GREEN_CHIP, l: "ready for review" },
      ].map((c, i) => (
        <div key={i} style={{ borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", padding: "7px 9px" }}>
          <div style={{ fontSize: 10, fontWeight: 600 }}>{c.t}</div>
          <div style={{ marginTop: 4 }}><Badge {...c.c}>{c.l}</Badge></div>
        </div>
      ))}
      {/* Live terminal in your pocket. */}
      <div style={{ marginTop: "auto", borderRadius: 8, border: "1px solid var(--hairline)", background: "#0b0e14", padding: "8px 9px", fontFamily: "var(--font-mono)", fontSize: 9, lineHeight: 1.8, color: "var(--text-2)" }}>
        <div><span style={{ color: "#8b7cf6" }}>●</span> Also print the Bun runtime version? (y/N)</div>
        <div>
          <span style={{ color: "#8b7cf6" }}>▸ </span>
          <Type text="y" delay={6.4} dur={0.5} caret />
        </div>
      </div>
    </div>
  );
}

function SceneAnywhere() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, background: STAGE_BG, pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: 44, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Eyebrow delay={300}>ACCESS FROM ANYWHERE</Eyebrow>
        <div style={{ marginTop: 12 }}>
          <TitleWords text="Your hardware. Any browser." delay={550} size={34} />
        </div>
      </div>

      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 64, paddingTop: 70 }}>
        {/* The phone — the same board, live, in your pocket. */}
        <div className="sc-pop" style={{ animationDelay: "1600ms", position: "relative" }}>
          <i aria-hidden className="sc-ringpulse" style={{ "--sc-rp-delay": "2.2s", "--sc-rp-times": "2", borderRadius: 30 } as CSSProperties} />
          <PhoneBoard />
          <div className="sc-pop-in" style={{ "--sc-pop-delay": "5s", position: "absolute", top: -12, right: -66 } as CSSProperties}>
            <Badge {...GREEN_CHIP}>live · your tunnel</Badge>
          </div>
        </div>

        {/* The path out — always a tunnel you own. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 380 }}>
          {[
            "$ tailscale serve 4666",
            "$ cloudflared tunnel --url http://127.0.0.1:4666",
            "$ ssh -L 4666:127.0.0.1:4666 you@server",
          ].map((c, i) => (
            <div
              key={c}
              className="sc-rise-sm"
              style={{
                animationDelay: `${4200 + i * 600}ms`,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                padding: "8px 12px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-2)",
              }}
            >
              {c}
            </div>
          ))}
          <div className="sc-fade" style={{ animationDelay: "6400ms", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-2)" }}>
            <I n="lock" s={13} style={{ color: "var(--green)" }} />
            token lives in the <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>#fragment</span> — never on the wire
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <span className="sc-pop-in" style={{ "--sc-pop-delay": "7.4s" } as CSSProperties}>
              <Badge {...GREEN_CHIP} icon="check">no relay</Badge>
            </span>
            <span className="sc-pop-in" style={{ "--sc-pop-delay": "7.8s" } as CSSProperties}>
              <Badge {...GREEN_CHIP} icon="check">no telemetry</Badge>
            </span>
            <span className="sc-pop-in" style={{ "--sc-pop-delay": "8.2s" } as CSSProperties}>
              <Badge>binds 127.0.0.1</Badge>
            </span>
          </div>
        </div>
      </div>

      <Glint delay={9400} style={{ position: "absolute", bottom: 34, left: "50%", transform: "translateX(-50%)" }}>
        the board follows you.
      </Glint>
    </div>
  );
}

/* ── 09 · Finale — the mark, the install, the star ───────────────────────── */

const MOTES: { x: number; y: number; cx: number; cy: number; del: number }[] = [
  { x: 130, y: 130, cx: 430, cy: 220, del: 0.1 },
  { x: 960, y: 110, cx: -400, cy: 240, del: 0.25 },
  { x: 110, y: 540, cx: 450, cy: -190, del: 0.4 },
  { x: 980, y: 560, cx: -420, cy: -210, del: 0.55 },
  { x: 300, y: 80, cx: 260, cy: 270, del: 0.7 },
  { x: 830, y: 90, cx: -270, cy: 260, del: 0.85 },
  { x: 420, y: 620, cx: 140, cy: -270, del: 1.0 },
  { x: 730, y: 610, cx: -170, cy: -260, del: 1.15 },
];

function SceneFinale({ replay }: SceneProps) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(52% 42% at 50% 12%, rgba(139,92,246,0.14), transparent 70%), radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(1,4,9,0.5))",
          pointerEvents: "none",
        }}
      />

      {/* Motes collapse into the mark. */}
      {MOTES.map((m, i) => (
        <span
          key={i}
          aria-hidden
          className="sc-converge"
          style={
            {
              left: m.x,
              top: m.y,
              width: 10,
              height: 10,
              borderRadius: 3,
              background: i % 2 ? "#8b5cf6" : "#3b3f4a",
              boxShadow: i % 2 ? "0 0 16px -2px rgba(139,92,246,0.7)" : "none",
              "--cx": `${m.cx}px`,
              "--cy": `${m.cy}px`,
              "--cv-del": `${m.del}s`,
              "--cv-dur": "1.7s",
            } as CSSProperties
          }
        />
      ))}

      {/* Ambient motes — the finale keeps breathing after it parks. */}
      <div aria-hidden className="sc-drift" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {[
          { x: "16%", y: "24%", s: 4, dx: "26px", dy: "-30px", d: "9s", del: "0s", c: "rgba(230,237,243,0.14)" },
          { x: "80%", y: "20%", s: 3, dx: "-30px", dy: "22px", d: "11s", del: "1s", c: "rgba(139,92,246,0.4)" },
          { x: "66%", y: "74%", s: 5, dx: "22px", dy: "26px", d: "10s", del: "0.4s", c: "rgba(230,237,243,0.10)" },
          { x: "28%", y: "80%", s: 3, dx: "-24px", dy: "-26px", d: "12s", del: "1.6s", c: "rgba(139,92,246,0.32)" },
          { x: "88%", y: "56%", s: 4, dx: "-18px", dy: "-22px", d: "8s", del: "0.8s", c: "rgba(230,237,243,0.12)" },
        ].map((m, i) => (
          <i
            key={i}
            style={
              {
                left: m.x,
                top: m.y,
                width: m.s,
                height: m.s,
                "--dx": m.dx,
                "--dy": m.dy,
                "--pd": m.d,
                "--pdel": m.del,
                "--pc": m.c,
              } as CSSProperties
            }
          />
        ))}
      </div>

      {/* The mark. */}
      <div className="sc-pop" style={{ animationDelay: "2000ms", position: "relative" }}>
        <i aria-hidden className="sc-ringpulse" style={{ "--sc-rp-delay": "2.5s", "--sc-rp-times": "infinite", "--sc-rp-dur": "3s" } as CSSProperties} />
        <span
          style={{
            width: 76,
            height: 76,
            borderRadius: 19,
            background: "#0e0d16",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 70px -14px rgba(139,92,246,0.75)",
          }}
        >
          <span style={{ width: 34, height: 34, borderRadius: 999, background: "#8b7cf6", boxShadow: "0 0 24px rgba(139,92,246,0.9)" }} />
        </span>
      </div>

      <h1 className="sc-rise" style={{ animationDelay: "2600ms", margin: "22px 0 0", fontSize: 66, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1 }}>
        rvmp
      </h1>
      <p className="sc-rise" style={{ animationDelay: "3200ms", margin: "12px 0 0", fontSize: 15, color: "var(--text-2)" }}>
        Your coding agents, on a board. Access from anywhere.
      </p>

      {/* The install. */}
      <div
        className="sc-rise"
        style={{
          animationDelay: "4000ms",
          marginTop: 26,
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "#0b0e14",
          padding: "11px 16px",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          color: "var(--text)",
          boxShadow: "0 18px 50px -20px rgba(1,4,9,0.9)",
        }}
      >
        <span style={{ color: "#8b7cf6" }}>$</span>
        <Type text="curl -fsSL https://codegent.io/install | sh" delay={4.5} dur={2.0} caret />
      </div>

      <div className="sc-fade" style={{ animationDelay: "7000ms", marginTop: 18, display: "flex", gap: 6 }}>
        <Badge>self-hosted</Badge>
        <Badge {...GREEN_CHIP}>no telemetry</Badge>
        <Badge {...VIOLET_CHIP}>agpl-3.0</Badge>
      </div>

      <div className="sc-rise" style={{ animationDelay: "7800ms", marginTop: 30, display: "flex", gap: 10 }}>
        <a
          href="https://github.com/burakgon/rvmp"
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            height: 42,
            padding: "0 22px",
            borderRadius: 999,
            background: "var(--violet)",
            color: "#fff",
            fontSize: 13.5,
            fontWeight: 600,
            textDecoration: "none",
            boxShadow: "0 0 34px -8px rgba(139,92,246,0.8)",
          }}
        >
          <I n="star" s={15} />
          Star on GitHub
        </a>
        <button
          type="button"
          onClick={replay}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            height: 42,
            padding: "0 22px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-2)",
            fontSize: 13.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <I n="replay" s={14} />
          Replay film
        </button>
      </div>

      <Glint delay={9200} style={{ marginTop: 30 }}>
        your agents are waiting.
      </Glint>

      <div
        className="sc-fade"
        style={{
          animationDelay: "10200ms",
          position: "absolute",
          bottom: 24,
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.2em",
          color: "var(--dim)",
        }}
      >
        TERMINAL CONTENT NEVER LEAVES THE TERMINAL
      </div>
    </div>
  );
}

/* ── Program ─────────────────────────────────────────────────────────────── */

export const SCENES: SceneDef[] = [
  {
    id: "genesis",
    eyebrow: "00 / RVMP",
    title: "Every agent, its own window",
    caption: "claude, codex, gemini, goose, aider, amp",
    duration: 9000,
    Component: SceneGenesis,
  },
  {
    id: "one-board",
    eyebrow: "01 / ONE BOARD",
    title: "rvmp",
    caption: "your coding agents, on a board",
    duration: 10000,
    Component: SceneIgnition,
  },
  {
    id: "board",
    eyebrow: "02 / THE BOARD",
    title: "A board that routes attention",
    caption: "state + elapsed, never chat",
    duration: 12000,
    Component: SceneBoard,
  },
  {
    id: "terminal",
    eyebrow: "03 / TERMINALS",
    title: "Real terminals, not chat",
    caption: "answer in the pty",
    duration: 12000,
    Component: SceneTerminal,
  },
  {
    id: "detection",
    eyebrow: "04 / DETECTION",
    title: "It knows — without reading a word",
    caption: "content-free, by principle",
    duration: 10000,
    Component: SceneDetection,
  },
  {
    id: "review",
    eyebrow: "05 / REVIEW",
    title: "Review like you mean it",
    caption: "diffs, viewed marks, queued comments",
    duration: 13000,
    Component: SceneReview,
  },
  {
    id: "merge",
    eyebrow: "06 / MERGE",
    title: "Round trips, then the green button",
    caption: "squash · merge · rebase · pr",
    duration: 10000,
    Component: SceneMerge,
  },
  {
    id: "agents",
    eyebrow: "07 / AGENTS",
    title: "Every agent, two tiers",
    caption: "premium hooks, universal detection",
    duration: 10000,
    Component: SceneAgents,
  },
  {
    id: "anywhere",
    eyebrow: "08 / ANYWHERE",
    title: "Your hardware, any browser",
    caption: "your tunnel, your token",
    duration: 11000,
    Component: SceneAnywhere,
  },
  {
    id: "finale",
    eyebrow: "09 / FINALE",
    title: "rvmp",
    caption: "self-hosted · no telemetry · agpl",
    duration: 12000,
    Component: SceneFinale,
  },
];
