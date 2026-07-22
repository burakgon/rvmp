import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card, Project, SessionMeta, Worktree } from "@rvmp/protocol";
import { api } from "../api";
import { AppCtx } from "../appCtx";
import { railSessionEntries } from "../projection";
import { addPane, loadLayout, MAX_PANES, movePane, normalizeSizes, removePane, sanitizeLayout, saveLayout, type TerminalLayout } from "../terminalLayout";
import { GhosttyTerm } from "./GhosttyTerm";
import { SessionRail } from "./SessionRail";

export function TerminalView({ project }: { project: Project }) {
  const { projectId, sessionFocus, focusSession } = useContext(AppCtx);
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions", projectId], queryFn: () => api.get<SessionMeta[]>(`/api/projects/${projectId}/sessions`) });
  const cards = useQuery({ queryKey: ["cards", projectId], queryFn: () => api.get<Card[]>(`/api/projects/${projectId}/cards`) });
  const worktrees = useQuery({ queryKey: ["worktrees", projectId], queryFn: () => api.get<Worktree[]>(`/api/projects/${projectId}/worktrees`) });
  const [layout, setLayout] = useState<TerminalLayout>(() => loadLayout(projectId));
  const [err, setErr] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; value: string } | null>(null);
  const paneHost = useRef<HTMLDivElement>(null);

  const railEntries = useMemo(
    () => railSessionEntries(sessions.data ?? [], cards.data ?? []),
    [sessions.data, cards.data],
  );
  const entryById = useMemo(() => new Map(railEntries.map(entry => [entry.session.id, entry])), [railEntries]);
  const validIds = useMemo(() => new Set(railEntries.map(entry => entry.session.id)), [railEntries]);

  useEffect(() => saveLayout(projectId, layout), [projectId, layout]);
  useEffect(() => {
    if (!sessions.isSuccess || !cards.isSuccess) return;
    setLayout(current => {
      const next = sanitizeLayout(current, validIds);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [sessions.isSuccess, cards.isSuccess, validIds]);

  const show = (id: string) => {
    setErr(null);
    const canFocus = layout.open.includes(id) || layout.open.length < MAX_PANES;
    setLayout(current => {
      const next = addPane(current, id);
      if (!next.added && !current.open.includes(id)) setErr("Four panes are already open. Close a pane before opening another session.");
      return next.layout;
    });
    if (canFocus) focusSession(id);
  };

  useEffect(() => {
    if (!sessionFocus || sessionFocus.projectId !== projectId) return;
    show(sessionFocus.sessionId);
  }, [projectId, sessionFocus]);

  const openNew = async (target: { kind: "main" } | { kind: "worktree"; id: string } | { kind: "new"; name: string; base?: string }) => {
    setErr(null);
    try {
      let cwd = project.path, worktreeId: string | null = null, title = "main";
      if (target.kind === "worktree") {
        const worktree = worktrees.data?.find(value => value.id === target.id);
        if (!worktree) throw new Error("worktree is no longer available");
        cwd = worktree.path; worktreeId = worktree.id; title = worktree.branch;
      } else if (target.kind === "new") {
        const worktree = await api.post<Worktree>(`/api/projects/${projectId}/worktrees`, { name: target.name, base: target.base });
        await qc.invalidateQueries({ queryKey: ["worktrees", projectId] });
        cwd = worktree.path; worktreeId = worktree.id; title = worktree.branch;
      }
      const meta = await api.post<SessionMeta>(`/api/projects/${projectId}/sessions`, { cwd, worktreeId, title });
      await qc.invalidateQueries({ queryKey: ["sessions", projectId] });
      show(meta.id);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  };

  const terminate = async (id: string) => {
    setErr(null);
    try {
      await api.del(`/api/sessions/${id}`);
      setLayout(current => removePane(current, id));
      await qc.invalidateQueries({ queryKey: ["sessions", projectId] });
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  };

  const saveRename = async () => {
    if (!rename?.value.trim()) return;
    try {
      await api.patch(`/api/sessions/${rename.id}`, { title: rename.value.trim() });
      setRename(null);
      await qc.invalidateQueries({ queryKey: ["sessions", projectId] });
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  };

  const resizeStart = (index: number, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const host = paneHost.current;
    if (!host) return;
    const start = layout.orientation === "columns" ? event.clientX : event.clientY;
    const extent = layout.orientation === "columns" ? host.clientWidth : host.clientHeight;
    const initial = [...layout.sizes];
    const pairTotal = initial[index]! + initial[index + 1]!;
    const onMove = (move: PointerEvent) => {
      const point = layout.orientation === "columns" ? move.clientX : move.clientY;
      const delta = (point - start) / Math.max(extent, 1);
      const first = Math.min(pairTotal - .12, Math.max(.12, initial[index]! + delta));
      const sizes = [...initial];
      sizes[index] = first;
      sizes[index + 1] = pairTotal - first;
      setLayout(current => ({ ...current, sizes: normalizeSizes(sizes, current.open.length) }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const rendered = layout.maximized ? layout.open.filter(id => id === layout.maximized) : layout.open;

  return (
    <div className="terminal-workspace">
      <SessionRail sessions={sessions.data ?? []} worktrees={worktrees.data ?? []} cards={cards.data ?? []}
        openIds={layout.open} focusedId={layout.focused} onPick={show} onNew={openNew} onTerminate={id => void terminate(id)} />
      <div className="terminal-main">
        <div className="terminal-toolbar">
          <span>{layout.open.length} pane{layout.open.length === 1 ? "" : "s"}</span>
          <button type="button" aria-pressed={layout.orientation === "columns"} onClick={() => setLayout(current => ({ ...current, orientation: "columns", maximized: null }))}>Columns</button>
          <button type="button" aria-pressed={layout.orientation === "rows"} onClick={() => setLayout(current => ({ ...current, orientation: "rows", maximized: null }))}>Rows</button>
          {layout.open.length > 0 && <button type="button" onClick={() => setLayout(current => ({ ...current, open: [], focused: null, sizes: [], maximized: null }))}>Close all panes</button>}
        </div>
        {err && <button type="button" className="terminal-error" onClick={() => setErr(null)}>{err}</button>}
        <div ref={paneHost} className={`pane-host pane-host-${layout.orientation}`}>
          {rendered.length === 0 && <div className="terminal-empty">Pick a session, or open a terminal from the rail.</div>}
          {rendered.map((sid, visibleIndex) => {
            const index = layout.open.indexOf(sid);
            const entry = entryById.get(sid);
            const session = entry?.session;
            const previous = !!entry?.previous;
            return (
              <React.Fragment key={sid}>
                {visibleIndex > 0 && <div role="separator" aria-orientation={layout.orientation === "columns" ? "vertical" : "horizontal"} className="pane-divider" onPointerDown={event => resizeStart(index - 1, event)} />}
                <section className={`terminal-pane${layout.focused === sid ? " focused" : ""}`} style={{ flexBasis: `${(layout.maximized ? 1 : layout.sizes[index] ?? 1) * 100}%` }} onFocusCapture={() => setLayout(current => ({ ...current, focused: sid }))}>
                  <header className="pane-header">
                    <span className={`session-dot ${session?.live ? "live" : "dead"}`} />
                    {rename?.id === sid ? (
                      <input className="pane-rename" autoFocus value={rename.value} onChange={event => setRename({ id: sid, value: event.target.value })}
                        onKeyDown={event => { if (event.key === "Enter") void saveRename(); if (event.key === "Escape") setRename(null); }} onBlur={() => void saveRename()} />
                    ) : <strong>{entry?.title ?? session?.title ?? sid}</strong>}
                    <small>{previous ? "previous session" : session?.kind ?? "session"}</small>
                    <button type="button" aria-label="Rename session" onClick={() => setRename({ id: sid, value: session?.title ?? entry?.title ?? sid })}>✎</button>
                    <button type="button" aria-label="Move pane left" disabled={index === 0 || !!layout.maximized} onClick={() => setLayout(current => movePane(current, sid, -1))}>←</button>
                    <button type="button" aria-label="Move pane right" disabled={index === layout.open.length - 1 || !!layout.maximized} onClick={() => setLayout(current => movePane(current, sid, 1))}>→</button>
                    <button type="button" aria-label={layout.maximized === sid ? "Restore panes" : "Maximize pane"} onClick={() => setLayout(current => ({ ...current, maximized: current.maximized === sid ? null : sid }))}>{layout.maximized === sid ? "⊞" : "□"}</button>
                    {session?.live && <button type="button" className="terminate-button" aria-label="Terminate session" title="Terminate process" onClick={() => void terminate(sid)}>■</button>}
                    <button type="button" aria-label="Close pane" title="Close pane without terminating" onClick={() => setLayout(current => removePane(current, sid))}>×</button>
                  </header>
                  <GhosttyTerm sid={sid} focused={layout.focused === sid} readOnly={previous} onFocus={() => show(sid)} />
                </section>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
