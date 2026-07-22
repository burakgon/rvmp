import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@rvmp/protocol";
import { api, connectWs, type CgSocket, type WsState } from "../api";
import { bindKeys } from "../keys";
import { reduceCardNotices, type CardNoticeState } from "../projection";
import { Sidebar, type ProjectSummary } from "./Sidebar";
import { Board } from "./Board";
import { TerminalView } from "./TerminalView";
import { DiffView } from "./DiffView";
import { Palette, type PaletteNavigation } from "./Palette";
import { ProjectSheet } from "./ProjectSheet";
import { AgentProbeStrip, SettingsView } from "./Settings";
import { createNotifier, notifyEnabled, onNotifyChange, setNotifyEnabled } from "../notify";
import { clearComments } from "../comments";

export { AppCtx, type SessionFocus, type View } from "../appCtx";
import { AppCtx, type SessionFocus, type View } from "../appCtx";

const validView = (value: string | null): View => value === "terminal" || value === "diff" || value === "settings" ? value : "board";
const locationState = () => {
  const params = new URLSearchParams(location.search);
  const projectId = params.get("project");
  const view = validView(params.get("view"));
  const card = Number(params.get("card"));
  const sessionId = params.get("session");
  return {
    projectId,
    view,
    diffFocus: Number.isInteger(card) && card > 0 ? card : null,
    sessionFocus: projectId && sessionId ? { projectId, sessionId } : null,
  };
};

export function Shell() {
  const qc = useQueryClient();
  const initial = useMemo(locationState, []);
  const [view, setView] = useState<View>(initial.view);
  const [projectId, setProjectId] = useState<string | null>(initial.projectId);
  const [sessionFocus, setSessionFocus] = useState<SessionFocus | null>(initial.sessionFocus);
  const [diffFocus, setDiffFocus] = useState<number | null>(initial.diffFocus);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const projectModal = useRef<HTMLDivElement>(null);
  const [cardNotices, projectNotice] = useReducer(reduceCardNotices, new Map());

  // Session ids are project-local UI targets. Keeping the project alongside
  // the id prevents a project switch from opening a stale pane by accident.
  const focusSession = useCallback((sessionId: string) => {
    if (!projectId) return;
    setSessionFocus(current => current?.projectId === projectId && current.sessionId === sessionId
      ? current
      : { projectId, sessionId });
    setView("terminal");
  }, [projectId]);

  // §7.5: clicking a review/done card focuses it in the diff view.
  const focusDiff = useCallback((cardId: number) => {
    setDiffFocus(cardId);
    setView("diff");
  }, []);

  const [notifOn, setNotifOn] = useState(notifyEnabled);
  useEffect(() => onNotifyChange(setNotifOn), []);
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
      qc.invalidateQueries({ queryKey: ["project-summaries"] });
    }
    if (ev.t === "session") qc.invalidateQueries({ queryKey: ["sessions"] });
    if (ev.t === "project" || ev.t === "projectDeleted") qc.invalidateQueries({ queryKey: ["projects"] });
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
  const summaries = useQuery({ queryKey: ["project-summaries"], queryFn: () => api.get<ProjectSummary[]>("/api/state/project-summaries") });
  useEffect(() => {
    if (!projects.data) return;
    if (projects.data.length === 0) { setProjectId(null); setView("board"); return; }
    if (!projectId || !projects.data.some(project => project.id === projectId)) {
      setProjectId(projects.data[0]!.id);
      setView("board");
      setSessionFocus(null);
      setDiffFocus(null);
    }
  }, [projects.data, projectId]);

  useEffect(() => bindKeys({
    "1": () => setView("board"), "2": () => setView("terminal"), "3": () => setView("diff"),
    k: () => setPaletteOpen(true), "mod+k": () => setPaletteOpen(true),
    n: () => setSheetOpen(true), t: () => setView("terminal"), escape: () => setPaletteOpen(false),
  }), []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    params.set("view", view);
    if (view === "diff" && diffFocus !== null) params.set("card", String(diffFocus));
    if (view === "terminal" && sessionFocus?.projectId === projectId) params.set("session", sessionFocus.sessionId);
    const next = `${location.pathname}?${params.toString()}`;
    if (`${location.pathname}${location.search}` !== next) history.replaceState(history.state, "", next);
  }, [projectId, view, diffFocus, sessionFocus]);

  useEffect(() => {
    const apply = () => {
      const next = locationState();
      setProjectId(next.projectId);
      setView(next.view);
      setDiffFocus(next.diffFocus);
      setSessionFocus(next.sessionFocus);
    };
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, []);

  useEffect(() => {
    if (!sheetOpen) return;
    const modal = projectModal.current;
    if (!modal) return;
    const focusable = () => [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setSheetOpen(false); return; }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (nodes.length === 0) return;
      const first = nodes[0]!, last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [sheetOpen]);

  const selectProject = (id: string, nextView: View = "board") => {
    setProjectId(id); setView(nextView); setSessionFocus(null); setDiffFocus(null);
  };
  const navigate = useCallback((target: PaletteNavigation) => {
    setProjectId(target.projectId);
    setView(target.view);
    setDiffFocus(target.cardId ?? null);
    setSessionFocus(target.sessionId ? { projectId: target.projectId, sessionId: target.sessionId } : null);
  }, []);

  const active = projects.data?.find(p => p.id === projectId);
  return (
    <div className="app-shell">
      {lost && (
        <div style={{ flexShrink: 0, textAlign: "center", fontSize: 11, padding: "4px 14px", color: "var(--amber)", background: "var(--surface)", borderBottom: "1px solid var(--surface-2)" }}>
          connection lost — retrying
        </div>
      )}
      <div className="app-body">
        <Sidebar projects={projects.data ?? []} summaries={summaries.data} activeId={projectId} onSelect={id => selectProject(id)} onSettings={id => selectProject(id, "settings")} onAdd={() => setSheetOpen(true)} />
        <main className="content-shell">
          <div className="topbar">
            <span style={{ fontSize: 13, fontWeight: 500 }}>{active?.name ?? "—"}</span>
            <div style={{ display: "flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
              {(["board", "terminal", "diff"] as View[]).map((v, i) => (
                <button type="button" key={v} onClick={() => setView(v)}
                  style={{ padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12,
                    border: 0,
                    background: view === v ? "var(--violet)" : "transparent",
                    color: view === v ? "var(--text-on-accent)" : "var(--ctrl)", fontWeight: view === v ? 500 : 400 }}>
                  {v[0].toUpperCase() + v.slice(1)} <b style={{ opacity: .55, fontWeight: 400 }}>{i + 1}</b>
                </button>
              ))}
            </div>
            <button type="button" aria-label="Settings" onClick={() => setView("settings")}
              style={{ marginLeft: "auto", display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: view === "settings" ? "var(--surface-2)" : "var(--surface)", color: view === "settings" ? "var(--violet-2)" : "var(--dim)", cursor: "pointer" }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M12.4 3.6l-1.35 1.35M4.95 11.05 3.6 12.4" />
              </svg>
            </button>
            <button type="button" aria-label={notifOn ? "Disable notifications" : "Enable notifications"}
              onClick={() => void setNotifyEnabled(!notifOn).then(setNotifOn)}
              style={{ display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: notifOn ? "var(--violet-2)" : "var(--dim)", cursor: "pointer" }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2.2a4 4 0 0 1 4 4c0 3 1.3 4 1.3 4H2.7S4 9.2 4 6.2a4 4 0 0 1 4-4Z" /><path d="M6.8 12.8a1.3 1.3 0 0 0 2.4 0" />
              </svg>
            </button>
            <button type="button" onClick={() => setPaletteOpen(true)} className="palette-trigger">⌘K <span>Search</span></button>
          </div>
          {active && projectId ? (
            <AppCtx.Provider value={{ projectId, view, setView, sessionFocus, focusSession, diffFocus, focusDiff, socket, cardNotices }}>
              {view === "board" && <Board project={active} />}
              {view === "terminal" && <TerminalView key={active.id} project={active} />}
              {view === "diff" && <DiffView />}
              {view === "settings" && <SettingsView project={active} />}
            </AppCtx.Provider>
          ) : (
            // belt-and-braces: the ws "project" event also invalidates, but this
            // covers the local tab even if the socket is down
            <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
              <div>
                <AgentProbeStrip />
                <ProjectSheet onDone={p => { qc.invalidateQueries({ queryKey: ["projects"] }); setProjectId(p.id); }} />
              </div>
            </div>
          )}
        </main>
      </div>
      {sheetOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && setSheetOpen(false)}>
          <div ref={projectModal} role="dialog" aria-modal="true" aria-label="Add project" className="project-modal">
            <ProjectSheet onClose={() => setSheetOpen(false)}
              onDone={p => { setSheetOpen(false); qc.invalidateQueries({ queryKey: ["projects"] }); setProjectId(p.id); }} />
          </div>
        </div>
      )}
      {paletteOpen && <Palette activeProjectId={projectId} onClose={() => setPaletteOpen(false)} onNavigate={navigate} onAddProject={() => setSheetOpen(true)} />}
    </div>
  );
}
