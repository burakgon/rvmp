import React, { useContext, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Card as CardT, CardPhase } from "@codegent/protocol";
import { api } from "../api";
import { AppCtx } from "./Shell";
import { CardView } from "./Card";

const COLUMNS: { phase: CardPhase; label: string }[] = [
  { phase: "queued", label: "QUEUE" }, { phase: "running", label: "RUNNING" },
  { phase: "waiting", label: "WAITING FOR INPUT" }, { phase: "review", label: "IN REVIEW" },
  { phase: "done", label: "DONE" },
];

export function Board() {
  const { projectId } = useContext(AppCtx);
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: ["cards", projectId], queryFn: () => api.get<CardT[]>(`/api/projects/${projectId}/cards`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cards", projectId] });
  const create = useMutation({
    mutationFn: (v: { title: string; agent: CardT["agent"] }) => api.post<CardT>(`/api/projects/${projectId}/cards`, { ...v, body: "" }),
    onSuccess: invalidate,
  });

  return (
    <div style={{ display: "flex", gap: 12, padding: 16, alignItems: "flex-start", overflow: "auto", flex: 1 }}>
      {COLUMNS.map(col => {
        const list = (cards.data ?? []).filter(c => c.phase === col.phase);
        return (
          <div key={col.phase} style={{ flex: 1, minWidth: 180 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", marginBottom: 10 }}>
              {col.label}
              <span style={{ background: "var(--surface-2)", borderRadius: 999, padding: "0 7px", fontSize: 9.5, color: "var(--meta)" }}>{list.length}</span>
            </div>
            {list.map(c => <CardView key={c.id} card={c} onChanged={invalidate} />)}
            {col.phase === "queued" && <Composer onCreate={(title, agent) => create.mutate({ title, agent })} />}
          </div>
        );
      })}
    </div>
  );
}

function Composer({ onCreate }: { onCreate: (title: string, agent: CardT["agent"]) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState<CardT["agent"]>("claude");
  if (!open) return (
    <div onClick={() => setOpen(true)}
      style={{ border: "1px dashed var(--border)", borderRadius: 8, color: "var(--dim)", fontSize: 11, textAlign: "center", padding: 7, cursor: "pointer" }}>
      + task
    </div>
  );
  return (
    <div style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: "10px 12px" }}>
      <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="What should be done?"
        onKeyDown={e => {
          if (e.key === "Enter" && title.trim()) { onCreate(title.trim(), agent); setTitle(""); setOpen(false); }
          if (e.key === "Escape") setOpen(false);
        }}
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11, padding: "7px 10px", outline: "none" }} />
      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
        {(["claude", "codex", "none"] as const).map(a => (
          <span key={a} onClick={() => setAgent(a)}
            style={{ fontSize: 10, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
              border: `1px solid ${agent === a ? "var(--violet-2)" : "var(--border)"}`,
              color: agent === a ? "#c4b5fd" : "var(--ctrl)" }}>{a}</span>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--dim)" }}>Enter → Queue</span>
      </div>
    </div>
  );
}
