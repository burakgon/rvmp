import React, { useEffect, useState } from "react";
import type { Card, SessionMeta, Worktree } from "@codegent/protocol";
import { formatElapsed, railSessionEntries } from "../projection";

export function SessionRail({ sessions, cards, worktrees, openIds, focusedId, onPick, onNew, now: fixedNow }: {
  sessions: SessionMeta[]; cards: Card[]; worktrees: Worktree[]; openIds: string[]; focusedId: string | null;
  now?: number;
  onPick: (id: string) => void;
  onNew: (target: { kind: "main" } | { kind: "worktree"; id: string } | { kind: "new"; name: string; base?: string }) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixedNow]);
  const now = fixedNow ?? clock;
  const entries = railSessionEntries(sessions, cards);
  return (
    <div style={{ width: 216, borderRight: "1px solid var(--surface-2)", background: "var(--bg-deep)", padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", margin: "4px 0 8px" }}>SESSIONS</div>
      {entries.map(({ session: s, title, agent, previous, state, stateSince }) => s.kind === "agent" ? (
        <button type="button" key={s.id} data-session-kind="agent" data-agent={agent ?? "agent"} data-previous-session={previous || undefined}
          onClick={() => onPick(s.id)}
          style={{ display: "flex", width: "100%", boxSizing: "border-box", gap: 9, padding: "7px 9px", borderRadius: 8, cursor: "pointer", appearance: "none", textAlign: "left", font: "inherit",
            background: s.id === focusedId ? "var(--surface)" : "transparent",
            border: `1px solid ${s.id === focusedId ? "var(--border)" : "transparent"}` }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: s.worktreeId ? "var(--violet-2)" : "var(--dim)", marginTop: 4, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: s.id === focusedId ? "var(--text)" : "var(--text-2)" }}>
              <AgentGlyph agent={agent} />
              <span style={{ minWidth: 0, fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
            </div>
            <div style={{ fontSize: 10, color: "var(--dim)", fontVariantNumeric: "tabular-nums" }}>{agent ?? "agent"} · {state} · {formatElapsed(now - stateSince)}</div>
          </div>
        </button>
      ) : (
        <button type="button" key={s.id} data-session-kind="shell" onClick={() => onPick(s.id)}
          style={{ display: "flex", width: "100%", boxSizing: "border-box", gap: 9, padding: "7px 9px", borderRadius: 8, cursor: "pointer", appearance: "none", textAlign: "left", font: "inherit",
            background: s.id === focusedId ? "var(--surface)" : "transparent",
            border: `1px solid ${s.id === focusedId ? "var(--border)" : "transparent"}` }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: s.worktreeId ? "var(--worktree-blue)" : "var(--shell-dot)", marginTop: 4, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: s.id === focusedId ? "var(--text)" : "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
            <div style={{ fontSize: 10, color: "var(--dim)" }}>{openIds.includes(s.id) ? "on screen" : "shell"}</div>
          </div>
        </button>
      ))}
      <div style={{ position: "relative", marginTop: 6 }}>
        <div onClick={() => setPicker(p => !p)}
          style={{ display: "flex", justifyContent: "center", gap: 5, border: "1px dashed var(--border)", borderRadius: 8, color: "var(--dim)", fontSize: 11, padding: "7px 9px", cursor: "pointer" }}>
          + terminal · main
        </div>
        {picker && (
          <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 6, zIndex: 30 }}>
            <div style={{ fontSize: 10, fontWeight: 650, color: "var(--dim)", padding: "4px 8px 6px", letterSpacing: ".6px" }}>OPEN WHERE?</div>
            <PickRow label="main" hint="default" onClick={() => { onNew({ kind: "main" }); setPicker(false); }} />
            {worktrees.filter(w => w.state === "active").map(w => (
              <PickRow key={w.id} label={w.branch} onClick={() => { onNew({ kind: "worktree", id: w.id }); setPicker(false); }} />
            ))}
            <div style={{ borderTop: "1px solid var(--surface-2)", margin: "5px 4px" }} />
            {newName === null
              ? <PickRow label="in a new worktree…" onClick={() => setNewName("")} />
              : <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder="branch name — e.g. spike"
                  onKeyDown={e => {
                    if (e.key === "Enter" && newName.trim()) { onNew({ kind: "new", name: newName.trim() }); setNewName(null); setPicker(false); }
                    if (e.key === "Escape") setNewName(null);
                  }}
                  style={{ width: "100%", boxSizing: "border-box", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11, padding: "6px 8px", outline: "none", marginTop: 4 }} />}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentGlyph({ agent }: { agent: "claude" | "codex" | null }) {
  const common = {
    width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
    strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true, style: { flexShrink: 0, color: agent === "claude" ? "var(--amber-soft)" : agent === "codex" ? "var(--green)" : "var(--violet-2)" },
  };
  if (agent === "claude") return (
    <svg {...common} data-agent-glyph="claude">
      <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
      <circle cx="8" cy="8" r="1.3" />
    </svg>
  );
  if (agent === "codex") return (
    <svg {...common} data-agent-glyph="codex">
      <path d="m8 1.8 5.3 3.1v6.2L8 14.2l-5.3-3.1V4.9Z" />
      <path d="M10.6 5.7A3.1 3.1 0 1 0 10.7 10" />
    </svg>
  );
  return <svg {...common} data-agent-glyph="agent"><path d="M8 2.2v11.6M3 5l10 6M13 5 3 11" /></svg>;
}

function PickRow({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <div onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, fontSize: 11, color: "var(--text-2)", cursor: "pointer" }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      {label}{hint && <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--dim)" }}>{hint}</span>}
    </div>
  );
}
