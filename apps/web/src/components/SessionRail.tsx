import React, { useEffect, useState } from "react";
import type { Card, SessionMeta, Worktree } from "@rvmp/protocol";
import { formatElapsed, railSessionEntries } from "../projection";

export function SessionRail({ sessions, cards, worktrees, openIds, focusedId, onPick, onNew, onTerminate, now: fixedNow }: {
  sessions: SessionMeta[]; cards: Card[]; worktrees: Worktree[]; openIds: string[]; focusedId: string | null;
  now?: number;
  onPick: (id: string) => void;
  onNew: (target: { kind: "main" } | { kind: "worktree"; id: string } | { kind: "new"; name: string; base?: string }) => void;
  onTerminate?: (id: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const [newBase, setNewBase] = useState("");
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixedNow]);
  const now = fixedNow ?? clock;
  const entries = railSessionEntries(sessions, cards);
  const createWorktree = () => {
    if (newName === null || !newName.trim()) return;
    onNew({ kind: "new", name: newName.trim(), base: newBase.trim() || undefined });
    setNewName(null); setNewBase(""); setPicker(false);
  };

  return (
    <aside className="session-rail" aria-label="Sessions">
      <div className="rail-title">SESSIONS</div>
      <div className="rail-scroll">
        {entries.map(({ session, title, agent, previous, state, stateSince }) => (
          <div className={`session-row-wrap${session.id === focusedId ? " focused" : ""}`} key={session.id}>
            <button type="button" className="session-row" data-session-kind={session.kind} data-agent={session.kind === "agent" ? agent ?? "agent" : undefined}
              data-previous-session={previous || undefined} onClick={() => onPick(session.id)}>
              <span className={`rail-dot ${session.kind} ${session.worktreeId ? "worktree" : ""}`} />
              <span className="session-copy">
                <span className="session-name">{session.kind === "agent" && <AgentGlyph agent={agent} />}{title}</span>
                <span className="session-meta">{session.kind === "agent" ? `${agent ?? "agent"} · ${state} · ${formatElapsed(now - stateSince)}` : openIds.includes(session.id) ? "on screen" : "shell"}</span>
              </span>
            </button>
            {session.live && onTerminate && <button type="button" className="rail-terminate" aria-label={`Terminate ${title}`} title="Terminate session" onClick={() => onTerminate(session.id)}>■</button>}
          </div>
        ))}
        {entries.length === 0 && <div className="rail-empty">No sessions yet</div>}
      </div>
      <div className="terminal-picker-wrap">
        <button type="button" className="new-terminal-button" aria-expanded={picker} onClick={() => setPicker(value => !value)}>+ terminal</button>
        {picker && (
          <div className="terminal-picker" role="dialog" aria-label="Open terminal">
            <div className="rail-title">OPEN WHERE?</div>
            <PickRow label="main" hint="default" onClick={() => { onNew({ kind: "main" }); setPicker(false); }} />
            {worktrees.filter(worktree => worktree.state === "active").map(worktree => (
              <PickRow key={worktree.id} label={worktree.branch} hint={worktree.sync !== "clean" ? worktree.sync : undefined} onClick={() => { onNew({ kind: "worktree", id: worktree.id }); setPicker(false); }} />
            ))}
            <div className="picker-rule" />
            {newName === null ? <PickRow label="New worktree…" onClick={() => setNewName("")} /> : (
              <div className="new-worktree-fields">
                <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="branch name"
                  onKeyDown={e => { if (e.key === "Enter") createWorktree(); if (e.key === "Escape") setNewName(null); }} />
                <input value={newBase} onChange={e => setNewBase(e.target.value)} placeholder="base branch (project default)"
                  onKeyDown={e => { if (e.key === "Enter") createWorktree(); if (e.key === "Escape") setNewName(null); }} />
                <div><button type="button" className="primary-button" disabled={!newName.trim()} onClick={createWorktree}>Create + open</button><button type="button" className="link-button" onClick={() => setNewName(null)}>Cancel</button></div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function AgentGlyph({ agent }: { agent: Card["agent"] | null }) {
  const common = {
    width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
    strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true, style: { flexShrink: 0, color: agent === "claude" ? "var(--amber-soft)" : agent === "codex" ? "var(--green)" : "var(--violet-2)" },
  };
  if (agent === "claude") return <svg {...common} data-agent-glyph="claude"><path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" /><circle cx="8" cy="8" r="1.3" /></svg>;
  if (agent === "codex") return <svg {...common} data-agent-glyph="codex"><path d="m8 1.8 5.3 3.1v6.2L8 14.2l-5.3-3.1V4.9Z" /><path d="M10.6 5.7A3.1 3.1 0 1 0 10.7 10" /></svg>;
  return <svg {...common} data-agent-glyph="agent"><path d="M8 2.2v11.6M3 5l10 6M13 5 3 11" /></svg>;
}

function PickRow({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return <button type="button" className="picker-row" onClick={onClick}><span>{label}</span>{hint && <small>{hint}</small>}</button>;
}
