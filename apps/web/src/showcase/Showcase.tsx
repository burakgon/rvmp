/* rvmp showcase — the player. Step-driven: every scene plays once, then
 * PARKS with its ambient loops alive until the viewer advances. Scene
 * internals are pure CSS mounted per scene, so pausing is a play-state flip
 * (.sc-film[data-paused]) and replay/seek is a remount. No motion library —
 * the remount transition is a CSS class. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I } from "./scenes";
import { SCENES } from "./scenes";

/** Design canvas — every scene is composed at this fixed size and the player
 * scales it to fit, so the choreography is pixel-deterministic everywhere. */
const DW = 1120;
const DH = 700;

/** Read ?scene=N (1-based) once. */
function initialScene(): number {
  const n = Number.parseInt(new URLSearchParams(window.location.search).get("scene") ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n - 1, 0), SCENES.length - 1) : 0;
}

function Wordmark() {
  return (
    <a href="/" aria-label="Back to the board" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none", color: "var(--text)" }}>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          background: "#0e0d16",
          border: "1px solid var(--border)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: 999, background: "#8b7cf6" }} />
      </span>
      <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.02em" }}>rvmp</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em", color: "var(--dim)" }}>THE FILM</span>
    </a>
  );
}

export function Showcase() {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(initialScene);
  const [cycle, setCycle] = useState(0); // bump to remount the current scene (replay)
  const [playing, setPlaying] = useState(true);
  const [ended, setEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [scale, setScale] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);

  const scene = SCENES[idx]!; // idx is clamped into range by goTo/initialScene
  const last = idx === SCENES.length - 1;

  const goTo = useCallback((i: number) => {
    setIdx(Math.min(Math.max(i, 0), SCENES.length - 1));
    setElapsed(0);
    setEnded(false);
  }, []);

  const replay = useCallback(() => {
    if (last && ended) {
      goTo(0); // film over — start from the top
      setPlaying(true);
      return;
    }
    setCycle((c) => c + 1);
    setElapsed(0);
    setEnded(false);
    setPlaying(true);
  }, [last, ended, goTo]);

  /* The film clock — rAF while playing. WALL-CLOCK (not dt accumulation):
   * elapsed = bank + (now - segmentStart), so throttled rAF ticks can't skew
   * the film against the CSS choreography, which runs on the compositor's
   * real clock. */
  const bankRef = useRef(0);
  const startRef = useRef(0);

  // Scene change rewinds the bank. Declared BEFORE the clock effect so the
  // clock's cleanup banks the outgoing segment first.
  useEffect(() => {
    bankRef.current = 0;
    startRef.current = performance.now();
  }, [idx, cycle]);

  useEffect(() => {
    if (!playing || ended) return;
    startRef.current = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      setElapsed(bankRef.current + (t - startRef.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      bankRef.current += performance.now() - startRef.current;
      cancelAnimationFrame(raf);
    };
  }, [playing, ended, idx, cycle]);

  /* No auto-advance — when a scene's clock runs out it PARKS: ambient loops
   * keep breathing and the viewer advances manually (ArrowRight / next). */
  useEffect(() => {
    if (elapsed < scene.duration) return;
    setElapsed(scene.duration);
    setEnded(true);
  }, [elapsed, scene.duration]);

  /* Shareable deep links — keep ?scene=N in sync without history spam. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (idx === 0) url.searchParams.delete("scene");
    else url.searchParams.set("scene", String(idx + 1));
    window.history.replaceState(null, "", url);
  }, [idx]);

  /* Fit the fixed design canvas into whatever frame the viewport gives us. */
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setScale(Math.min(r.width / DW, r.height / DH));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen();
  }, []);

  const togglePlay = useCallback(() => {
    if (ended) {
      replay();
      return;
    }
    setPlaying((p) => !p);
  }, [ended, replay]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight") goTo(idx + 1);
      else if (e.key === "ArrowLeft") goTo(idx - 1);
      else if (e.key === "Home") goTo(0);
      else if (e.key === "End") goTo(SCENES.length - 1);
      else if (e.key === "r" || e.key === "R") replay();
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, goTo, replay, togglePlay, toggleFullscreen]);

  /* The scene tree is memoized so the 60fps clock re-renders only the chrome. */
  const sceneEl = useMemo(() => {
    const C = scene.Component;
    return <C replay={replay} />;
  }, [scene, replay]);

  const chromeBtn: React.CSSProperties = {
    display: "flex",
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: "var(--meta)",
    cursor: "pointer",
  };

  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        height: "100dvh",
        flexDirection: "column",
        overflow: "hidden",
        userSelect: "none",
        background:
          "radial-gradient(120% 90% at 50% 0%, rgba(139,92,246,0.07), transparent 60%), var(--bg-deep)",
        color: "var(--text)",
      }}
    >
      {/* ── Projection booth ── */}
      <header style={{ display: "flex", height: 56, flexShrink: 0, alignItems: "center", gap: 16, padding: "0 20px" }}>
        <Wordmark />
        <div style={{ display: "flex", minWidth: 0, flex: 1, alignItems: "center", gap: 6 }} role="tablist" aria-label="Scenes">
          {SCENES.map((s, i) => {
            const fill = i < idx ? 100 : i > idx ? 0 : Math.min(100, (elapsed / s.duration) * 100);
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={i === idx}
                aria-label={`${s.eyebrow} — ${s.title}`}
                onClick={() => goTo(i)}
                style={{ height: 24, minWidth: 0, flex: 1, border: "none", background: "transparent", padding: 0, cursor: "pointer" }}
              >
                <span style={{ display: "block", height: 3, overflow: "hidden", borderRadius: 999, background: "rgba(230,237,243,0.08)" }}>
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      borderRadius: 999,
                      width: `${fill}%`,
                      background: i === idx ? "#8b5cf6" : "rgba(230,237,243,0.35)",
                      boxShadow: i === idx ? "0 0 8px rgba(139,92,246,0.7)" : "none",
                    }}
                  />
                </span>
              </button>
            );
          })}
        </div>
        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", color: "var(--dim)" }}>
          {String(idx + 1).padStart(2, "0")} / {String(SCENES.length).padStart(2, "0")}
        </span>
      </header>

      {/* ── Screen ── */}
      <div ref={frameRef} style={{ position: "relative", minHeight: 0, minWidth: 0, flex: 1, margin: "0 20px" }}>
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: `translate(-50%, -50%) scale(${scale})` }}>
          <div
            data-paused={!playing}
            className="sc-film"
            style={{
              position: "relative",
              overflow: "hidden",
              width: DW,
              height: DH,
              borderRadius: 18,
              border: "1px solid var(--border)",
              background: "var(--bg-deep)",
              boxShadow: "0 40px 120px -40px rgba(1,4,9,0.9), 0 0 80px -30px rgba(139,92,246,0.35)",
            }}
          >
            <div key={`${idx}:${cycle}`} className="sc-enter" style={{ position: "absolute", inset: 0, zIndex: 10 }}>
              {sceneEl}
            </div>
          </div>
        </div>
      </div>

      {/* ── Transport ── */}
      <footer style={{ display: "flex", height: 64, flexShrink: 0, alignItems: "center", gap: 12, padding: "0 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button type="button" onClick={() => goTo(idx - 1)} disabled={idx === 0} aria-label="Previous scene" style={{ ...chromeBtn, opacity: idx === 0 ? 0.3 : 1 }}>
            <I n="left" s={16} />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing && !ended ? "Pause" : "Play"}
            style={{
              ...chromeBtn,
              width: 40,
              height: 40,
              borderRadius: 999,
              background: "var(--violet)",
              color: "#fff",
              boxShadow: "0 0 20px -4px rgba(139,92,246,0.7)",
            }}
          >
            {ended ? <I n="replay" s={16} /> : playing ? <I n="pause" s={16} /> : <I n="play" s={16} />}
          </button>
          <button
            type="button"
            onClick={() => goTo(idx + 1)}
            disabled={last}
            aria-label="Next scene"
            style={{
              ...chromeBtn,
              opacity: last ? 0.3 : 1,
              ...(ended && !last
                ? { color: "#b7a6ff", boxShadow: "inset 0 0 0 1px rgba(139,92,246,0.55), 0 0 16px -4px rgba(139,92,246,0.6)", animation: "sc-blink-soft-kf 1.6s ease-in-out infinite" }
                : null),
            }}
          >
            <I n="right" s={16} />
          </button>
        </div>

        <div style={{ display: "flex", minWidth: 0, flex: 1, alignItems: "baseline", justifyContent: "center", gap: 12, overflow: "hidden" }}>
          <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.2em", color: "#8b5cf6" }}>
            {scene.eyebrow}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, fontSize: 13 }}>{scene.title}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--meta)" }}>{scene.caption}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button type="button" onClick={replay} aria-label="Replay scene" style={chromeBtn}>
            <I n="replay" s={15} />
          </button>
          <button type="button" onClick={toggleFullscreen} aria-label="Toggle fullscreen" style={chromeBtn}>
            <I n={fullscreen ? "min" : "max"} s={15} />
          </button>
          <a
            href="https://github.com/burakgon/rvmp"
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              height: 36,
              marginLeft: 6,
              padding: "0 16px",
              borderRadius: 999,
              background: "var(--violet)",
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              textDecoration: "none",
              boxShadow: "0 0 20px -6px rgba(139,92,246,0.7)",
            }}
          >
            <I n="star" s={13} />
            Star
          </a>
        </div>
      </footer>
    </div>
  );
}
