import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@codegent/protocol";
import { api } from "../api";
import type { View } from "./Shell";

export function Palette({ onClose, onJump }: { onClose: () => void; onJump: (projectId: string, view: View) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", justifyContent: "center", paddingTop: 60, zIndex: 50 }}>
      <div style={{ width: 540, maxHeight: 380, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "auto", padding: 8, alignSelf: "flex-start" }}>
        <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", padding: "6px 8px" }}>PROJECTS</div>
        {(projects.data ?? []).map(p => (
          <div key={p.id} onClick={() => onJump(p.id, "board")}
            style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
            {p.name}
          </div>
        ))}
      </div>
    </div>
  );
}
