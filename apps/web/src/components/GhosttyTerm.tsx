import React, { useContext, useEffect, useRef, useState } from "react";
// Real engine API per docs/research/ghostty-web-spike.md (Task 3):
// `await init()` loads the shared WASM before the first `new Terminal`;
// onData/onResize are IEvent<T> — subscribing returns an IDisposable.
import { init, Terminal, FitAddon } from "ghostty-web";
import { AppCtx } from "./Shell";

// Upstream init() has no concurrent-call guard (two panes mounting at once
// would each run Ghostty.load()) — single-flight it here. A rejection must
// not be cached forever (one flaky load would blank every future pane):
// reset so a later mount retries.
let wasmReady: Promise<void> | null = null;
const ensureInit = () => (wasmReady ??= init().catch(e => { wasmReady = null; throw e; }));

// The engine config wants concrete strings; resolve them from the same
// theme.css tokens the rest of the UI uses (including the mono stack).
const cssToken = (token: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(token).trim();

// Full clear — home, clear screen, clear scrollback (spike §3 caveat 1).
// Written on mount (upstream stale-memory bug) and again before every ws
// re-sub, so the replayed ring snapshot always lands on a clean screen.
const SANITIZE = "\x1b[H\x1b[2J\x1b[3J";

export function GhosttyTerm({ sid, focused, readOnly = false, onFocus }: { sid: string; focused: boolean; readOnly?: boolean; onFocus: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [engineFailed, setEngineFailed] = useState(false);
  const { socket } = useContext(AppCtx);

  useEffect(() => {
    const el = ref.current!;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      try {
        await ensureInit();
      } catch {
        if (!cancelled) setEngineFailed(true); // pane shows a message, not a silent blank
        return;
      }
      if (cancelled) return; // unmounted (or StrictMode first pass) while WASM loaded
      setEngineFailed(false);
      const term = new Terminal({
        cols: 100, rows: 30, fontSize: 12,
        fontFamily: cssToken("--font-mono"),
        theme: { background: cssToken("--bg"), foreground: cssToken("--text") },
      });
      termRef.current = term;
      term.open(el);
      // Upstream stale-memory bug: a fresh terminal can start with a disposed
      // one's screen contents, and reset() does not clear it. Sanitize before
      // any bytes arrive (spike §3 caveat 1).
      term.write(SANITIZE);
      // Real cell metrics via FitAddon (spike-recorded API) instead of
      // guessed px-per-cell divisors; observeResize() re-fits on pane resize.
      const fit = new FitAddon();
      term.loadAddon(fit);
      const onResize = term.onResize(({ cols, rows }) => {
        if (!readOnly) socket.resize(sid, cols, rows);
      });
      const onData = term.onData(d => {
        if (!readOnly && d.length > 0) socket.input(sid, new TextEncoder().encode(d));
      });
      fit.fit(); // size to the pane before replay arrives
      fit.observeResize();
      // sub only after init + open + sanitize: the first frame is the full
      // ring snapshot. Guard zero-length writes — write("") crashes the WASM
      // (spike §3 caveat 2), and a fresh session's ring snapshot IS empty.
      const offBytes = socket.sub(sid, bytes => {
        if (bytes.length > 0) term.write(bytes);
      });
      // After a reconnect the socket re-subs this sid from its handler map
      // and the server replays the full ring snapshot; onReconnect callbacks
      // run before those re-subs go out (api.ts contract), so this write is
      // always enqueued into the term ahead of the snapshot — same rule as
      // mount, or the replay lands on top of the old screen.
      const offReconnect = socket.onReconnect(() => term.write(SANITIZE));
      if (!readOnly) socket.resize(sid, term.cols, term.rows); // sync the PTY even if fit() no-oped
      cleanup = () => {
        offReconnect(); // this pane must not sanitize after teardown began
        offBytes(); // detach BEFORE dispose — no bytes may hit a disposed terminal
        onData.dispose();
        onResize.dispose();
        fit.dispose(); // disconnects its ResizeObserver
        term.dispose();
        termRef.current = null;
      };
    })();

    return () => { cancelled = true; cleanup?.(); cleanup = null; };
  }, [sid, socket, readOnly]);

  // Rail picks focus an already-open pane without a click; on first mount the
  // engine's open() self-focuses, so the null termRef during init is fine.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div data-term data-read-only={readOnly || undefined} ref={ref} onMouseDown={onFocus}
      style={{ flex: 1, minWidth: 0, opacity: focused ? 1 : .75, transition: "opacity .2s", background: "var(--bg)" }}>
      {engineFailed && (
        <div style={{ display: "grid", placeItems: "center", height: "100%", fontSize: 11, color: "var(--red)" }}>
          terminal engine failed to load — reload to retry
        </div>
      )}
    </div>
  );
}
