import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Card, Project, SessionMeta } from "@rvmp/protocol";
import { api } from "../api";
import type { View } from "./Shell";

export type PaletteNavigation = { projectId: string; view: View; cardId?: number; sessionId?: string };

type Index = { project: Project; cards: Card[]; sessions: SessionMeta[] };
type Item = { key: string; group: string; label: string; detail: string; search: string; run: () => void };

export function Palette({ activeProjectId, onClose, onNavigate, onAddProject }: {
  activeProjectId: string | null;
  onClose: () => void;
  onNavigate: (target: PaletteNavigation) => void;
  onAddProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  const index = useQuery({
    queryKey: ["palette-index", (projects.data ?? []).map(project => project.id).join(",")],
    enabled: !!projects.data,
    queryFn: async (): Promise<Index[]> => Promise.all((projects.data ?? []).map(async project => ({
      project,
      cards: await api.get<Card[]>(`/api/projects/${project.id}/cards`),
      sessions: await api.get<SessionMeta[]>(`/api/projects/${project.id}/sessions`),
    }))),
  });

  const items = useMemo(() => {
    const result: Item[] = [];
    const active = (projects.data ?? []).find(project => project.id === activeProjectId);
    result.push({ key: "command:add-project", group: "COMMANDS", label: "Add project", detail: "Open repository wizard", search: "add new project repository", run: onAddProject });
    if (active) {
      for (const view of ["board", "terminal", "diff", "settings"] as View[]) {
        result.push({ key: `command:${view}`, group: "COMMANDS", label: `Open ${view}`, detail: active.name, search: `open go ${view} ${active.name}`, run: () => onNavigate({ projectId: active.id, view }) });
      }
    }
    for (const row of index.data ?? []) {
      result.push({ key: `project:${row.project.id}`, group: "PROJECTS", label: row.project.name, detail: row.project.path, search: `${row.project.name} ${row.project.path}`, run: () => onNavigate({ projectId: row.project.id, view: "board" }) });
      for (const card of row.cards) {
        const currentSession = card.attemptId === null ? undefined : row.sessions.find(session => session.attemptId === card.attemptId && session.live)
          ?? [...row.sessions].reverse().find(session => session.attemptId === card.attemptId);
        const target: PaletteNavigation = card.phase === "review" || card.phase === "done"
          ? { projectId: row.project.id, view: "diff", cardId: card.id }
          : currentSession ? { projectId: row.project.id, view: "terminal", sessionId: currentSession.id }
          : { projectId: row.project.id, view: "board" };
        result.push({ key: `card:${card.id}`, group: "TASKS", label: card.title, detail: `${row.project.name} · #${card.id} · ${card.phase}`, search: `${card.title} ${card.body} ${card.agent} ${card.phase} ${row.project.name}`, run: () => onNavigate(target) });
      }
      for (const session of row.sessions.filter(value => value.live)) {
        result.push({ key: `session:${session.id}`, group: "SESSIONS", label: session.title, detail: `${row.project.name} · ${session.kind}`, search: `${session.title} ${session.cwd} ${row.project.name} terminal session`, run: () => onNavigate({ projectId: row.project.id, view: "terminal", sessionId: session.id }) });
      }
    }
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return terms.length === 0 ? result : result.filter(item => terms.every(term => item.search.toLowerCase().includes(term)));
  }, [activeProjectId, index.data, onAddProject, onNavigate, projects.data, query]);

  useEffect(() => setSelected(0), [query]);
  const choose = (item: Item | undefined) => { if (!item) return; item.run(); onClose(); };

  return (
    <div className="palette-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="palette-dialog" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
        <div className="palette-search"><span aria-hidden="true">⌕</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search projects, tasks, sessions, or commands…"
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); setSelected(value => Math.min(items.length - 1, value + 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setSelected(value => Math.max(0, value - 1)); }
            if (event.key === "Enter") { event.preventDefault(); choose(items[selected]); }
            if (event.key === "Escape") onClose();
          }} /></div>
        <div className="palette-results" role="listbox" aria-label="Results">
          {items.map((item, indexValue) => {
            const startsGroup = indexValue === 0 || items[indexValue - 1]?.group !== item.group;
            return <React.Fragment key={item.key}>
              {startsGroup && <div className="palette-group">{item.group}</div>}
              <button type="button" role="option" aria-selected={selected === indexValue} onMouseEnter={() => setSelected(indexValue)} onClick={() => choose(item)}>
                <strong>{item.label}</strong><span>{item.detail}</span>
              </button>
            </React.Fragment>;
          })}
          {items.length === 0 && <div className="palette-empty">No matching projects, tasks, sessions, or commands.</div>}
        </div>
        <footer><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></footer>
      </div>
    </div>
  );
}
