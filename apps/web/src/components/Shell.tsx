import React, { createContext, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@codegent/protocol";
import { api, connectWs, type CgSocket } from "../api";
import { bindKeys } from "../keys";
import { Sidebar } from "./Sidebar";
import { Board } from "./Board";
import { TerminalView } from "./TerminalView";
import { Palette } from "./Palette";

export type View = "board" | "terminal" | "diff";
export const AppCtx = createContext<{ projectId: string; view: View; setView: (v: View) => void; socket: CgSocket }>(null as any);

export function Shell() {
  const qc = useQueryClient();
  const [view, setView] = useState<View>("board");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const socket = useMemo(() => connectWs(ev => {
    if (ev.t === "card" || ev.t === "cardDeleted") qc.invalidateQueries({ queryKey: ["cards"] });
    if (ev.t === "session") qc.invalidateQueries({ queryKey: ["sessions"] });
    if (ev.t === "project") qc.invalidateQueries({ queryKey: ["projects"] });
  }), []);

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
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar projects={projects.data ?? []} activeId={projectId} onSelect={setProjectId} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--surface-2)", background: "var(--bg-deep)" }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{active?.name ?? "—"}</span>
          <div style={{ display: "flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
            {(["board", "terminal", "diff"] as View[]).map((v, i) => (
              <span key={v} onClick={() => setView(v)}
                style={{ padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12,
                  background: view === v ? "var(--violet)" : "transparent",
                  color: view === v ? "#fff" : "var(--ctrl)", fontWeight: view === v ? 500 : 400 }}>
                {v[0].toUpperCase() + v.slice(1)} <b style={{ opacity: .55, fontWeight: 400 }}>{i + 1}</b>
              </span>
            ))}
          </div>
          <span onClick={() => setPaletteOpen(true)}
            style={{ marginLeft: "auto", fontSize: 11, color: "var(--ctrl)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 11px", cursor: "pointer" }}>
            K palette
          </span>
        </div>
        {active && projectId ? (
          <AppCtx.Provider value={{ projectId, view, setView, socket }}>
            {view === "board" && <Board />}
            {view === "terminal" && <TerminalView project={active} />}
            {view === "diff" && <div style={{ display: "grid", placeItems: "center", flex: 1, color: "var(--dim)" }}>nothing to review</div>}
          </AppCtx.Provider>
        ) : (
          // belt-and-braces: the ws "project" event also invalidates, but this
          // covers the local tab even if the socket is down
          <AddFirstProject onDone={id => { qc.invalidateQueries({ queryKey: ["projects"] }); setProjectId(id); }} />
        )}
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
