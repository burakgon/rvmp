import React, { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@codegent/protocol";
import { api, connectWs, type CgSocket, type WsState } from "../api";
import { bindKeys } from "../keys";
import { reduceCardNotices, type CardNoticeState } from "../projection";
import { Sidebar } from "./Sidebar";
import { Board } from "./Board";
import { TerminalView } from "./TerminalView";
import { DiffView } from "./DiffView";
import { Palette } from "./Palette";
import { createNotifier, notifyEnabled, setNotifyEnabled } from "../notify";
import { clearComments } from "../comments";

export { AppCtx, type SessionFocus, type View } from "../appCtx";
import { AppCtx, type SessionFocus, type View } from "../appCtx";

export function Shell() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("board");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionFocus, setSessionFocus] = useState<SessionFocus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cardNotices, projectNotice] = useReducer(reduceCardNotices, new Map());

  // Session ids are project-local UI targets. Keeping the project alongside
  // the id prevents a project switch from opening a stale pane by accident.
  const focusSession = useCallback((sessionId: string) => {
    if (!projectId) return;
    setSessionFocus({ projectId, sessionId });
    setView("terminal");
  }, [projectId]);

  // §7.5: clicking a review/done card focuses it in the diff view.
  const [diffFocus, setDiffFocus] = useState<number | null>(null);
  const focusDiff = useCallback((cardId: number) => {
    setDiffFocus(cardId);
    setView("diff");
  }, []);

  const [notifOn, setNotifOn] = useState(notifyEnabled);
  const notifier = useMemo(() => createNotifier(), []);

  const socket = useMemo(() => connectWs(ev => {
    projectNotice(ev);
    notifier.onEvent(ev);
    // Queued review comments die with the review (review B8): a merged,
    // cancelled, or deleted card can never send them back.
    if (ev.t === "cardDeleted") clearComments(ev.id);
    if (ev.t === "card" && (ev.card.phase === "done" || ev.card.phase === "cancelled")) clearComments(ev.card.id);
    if (ev.t === "card" || ev.t === "cardDeleted") {
      qc.invalidateQueries({ queryKey: ["cards"] });
      // diff surfaces recompute on any card movement (round, update, merge)
      qc.invalidateQueries({ queryKey: ["diff"] });
      qc.invalidateQueries({ queryKey: ["diffsum"] });
      qc.invalidateQueries({ queryKey: ["reviewed"] });
    }
    if (ev.t === "session") qc.invalidateQueries({ queryKey: ["sessions"] });
    if (ev.t === "project") qc.invalidateQueries({ queryKey: ["projects"] });
  }), []);

  // The strip appears only once "down" has persisted >1s — an instant
  // reconnect never flashes it. "down" is stable across retry attempts
  // (api.ts state machine), so the timer isn't reset by failed attempts.
  const [lost, setLost] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const apply = (s: WsState) => {
      if (s === "down") t ??= setTimeout(() => setLost(true), 1000);
      else {
        if (t) { clearTimeout(t); t = null; }
        setLost(false);
      }
    };
    apply(socket.state);
    const offState = socket.onState(apply);
    // A reopened socket may have missed any number of events — refetch the
    // world. Terminal re-subs are the socket's own job (handler map).
    const offReconnect = socket.onReconnect(() => qc.invalidateQueries());
    return () => {
      offState();
      offReconnect();
      if (t) clearTimeout(t);
      socket.close(); // clears handlers/queue/timers — no retry loop survives
    };
  }, [socket]);

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(projects.data[0].id);
  }, [projects.data, projectId]);

  useEffect(() => bindKeys({
    "1": () => setView("board"), "2": () => setView("terminal"), "3": () => setView("diff"),
    k: () => setPaletteOpen(true), escape: () => setPaletteOpen(false),
  }), []);

  const active = projects.data?.find(p => p.id === projectId);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {lost && (
        <div style={{ flexShrink: 0, textAlign: "center", fontSize: 11, padding: "4px 14px", color: "var(--amber)", background: "var(--surface)", borderBottom: "1px solid var(--surface-2)" }}>
          connection lost — retrying
        </div>
      )}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Sidebar projects={projects.data ?? []} activeId={projectId} onSelect={setProjectId} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--surface-2)", background: "var(--bg-deep)" }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{active?.name ?? "—"}</span>
            <div style={{ display: "flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
              {(["board", "terminal", "diff"] as View[]).map((v, i) => (
                <span key={v} onClick={() => setView(v)}
                  style={{ padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12,
                    background: view === v ? "var(--violet)" : "transparent",
                    color: view === v ? "var(--text-on-accent)" : "var(--ctrl)", fontWeight: view === v ? 500 : 400 }}>
                  {v[0].toUpperCase() + v.slice(1)} <b style={{ opacity: .55, fontWeight: 400 }}>{i + 1}</b>
                </span>
              ))}
            </div>
            <button type="button" aria-label={notifOn ? "Disable notifications" : "Enable notifications"}
              onClick={() => void setNotifyEnabled(!notifOn).then(setNotifOn)}
              style={{ marginLeft: "auto", display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: notifOn ? "var(--violet-2)" : "var(--dim)", cursor: "pointer" }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2.2a4 4 0 0 1 4 4c0 3 1.3 4 1.3 4H2.7S4 9.2 4 6.2a4 4 0 0 1 4-4Z" /><path d="M6.8 12.8a1.3 1.3 0 0 0 2.4 0" />
              </svg>
            </button>
            <span onClick={() => setPaletteOpen(true)}
              style={{ fontSize: 11, color: "var(--ctrl)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 11px", cursor: "pointer" }}>
              K palette
            </span>
          </div>
          {active && projectId ? (
            <AppCtx.Provider value={{ projectId, view, setView, sessionFocus, focusSession, diffFocus, focusDiff, socket, cardNotices }}>
              {view === "board" && <Board project={active} />}
              {view === "terminal" && <TerminalView project={active} />}
              {view === "diff" && <DiffView />}
            </AppCtx.Provider>
          ) : (
            // belt-and-braces: the ws "project" event also invalidates, but this
            // covers the local tab even if the socket is down
            <AddFirstProject onDone={id => { qc.invalidateQueries({ queryKey: ["projects"] }); setProjectId(id); }} />
          )}
        </div>
      </div>
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} onJump={(pid, v) => { setProjectId(pid); setView(v); setPaletteOpen(false); }} />}
    </div>
  );
}

function AddFirstProject({ onDone }: { onDone: (id: string) => void }) {
  const [path, setPath] = useState("");
  const [err, setErr] = useState("");
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
      <div style={{ width: 420 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Add a project</div>
        <input value={path} onChange={e => setPath(e.target.value)} placeholder="/absolute/path/to/git/repo"
          onKeyDown={async e => {
            if (e.key !== "Enter") return;
            const name = path.replace(/\/+$/, "").split("/").pop() || "project";
            try { onDone((await api.post<Project>("/api/projects", { name, path })).id); }
            catch (err) { setErr(err instanceof Error ? err.message : String(err)); }
          }}
          style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", padding: "8px 10px", fontSize: 12, outline: "none" }} />
        {err && <div style={{ color: "var(--red)", fontSize: 11, marginTop: 6 }}>{err}</div>}
      </div>
    </div>
  );
}
