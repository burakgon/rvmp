import React, { useState } from "react";
import type { Card, CardPhase } from "@codegent/protocol";
import { api } from "../api";

const PHASES: CardPhase[] = ["queued", "running", "waiting", "review", "done", "cancelled"];

export function CardView({ card, onChanged }: { card: Card; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const move = async (phase: CardPhase) => { await api.patch(`/api/cards/${card.id}`, { phase }); setMenu(false); onChanged(); };
  const del = async () => { await api.del(`/api/cards/${card.id}`); onChanged(); };
  return (
    <div style={{ position: "relative", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}
      onMouseLeave={() => setMenu(false)}>
      <div style={{ fontSize: 12, fontWeight: 500, opacity: card.phase === "done" ? .55 : 1, textDecoration: card.phase === "done" ? "line-through" : "none" }}>{card.title}</div>
      <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
        {card.agent !== "none" && (
          <span style={{ fontSize: 9.5, borderRadius: 6, padding: "1px 8px",
            border: "1px solid rgba(139,92,246,.28)", background: "rgba(139,92,246,.09)", color: "#c4b5fd" }}>{card.agent}</span>
        )}
      </div>
      <span onClick={() => setMenu(m => !m)}
        style={{ position: "absolute", top: 8, right: 10, cursor: "pointer", color: "var(--dim)" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
      </span>
      {menu && (
        <div style={{ position: "absolute", top: 24, right: 8, zIndex: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, minWidth: 140, boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>
          {PHASES.filter(p => p !== card.phase).map(p => (
            <div key={p} onClick={() => move(p)} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", color: "var(--text-2)" }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              move → {p}
            </div>
          ))}
          <div onClick={del} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", color: "var(--red)", borderTop: "1px solid var(--hairline)", marginTop: 4 }}>delete</div>
        </div>
      )}
    </div>
  );
}
