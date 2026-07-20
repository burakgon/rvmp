import React, { useContext, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card as CardT, Project, SessionMeta } from "@codegent/protocol";
import { api } from "../api";
import { cardRoutesToTerminal, columnOf, interruptedMessage, terminalSessionForCard, type BoardColumn } from "../projection";
import { AppCtx } from "./Shell";
import { CardView } from "./Card";
import { Details } from "./Details";

export { columnOf } from "../projection";

const COLUMNS: { id: BoardColumn; label: string }[] = [
  { id: "queue", label: "QUEUE" },
  { id: "running", label: "RUNNING" },
  { id: "waiting", label: "WAITING FOR INPUT" },
  { id: "review", label: "IN REVIEW" },
  { id: "done", label: "DONE" },
];

type DrawerState = { cardId: number; sendBack: boolean } | null;

export function Board({ project }: { project: Project }) {
  const { projectId, focusSession, cardNotices } = useContext(AppCtx);
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [discardedId, setDiscardedId] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const cards = useQuery({
    queryKey: ["cards", projectId],
    queryFn: () => api.get<CardT[]>(`/api/projects/${projectId}/cards`),
  });
  const sessions = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.get<SessionMeta[]>(`/api/projects/${projectId}/sessions`),
  });
  const interrupted = useQuery({
    queryKey: ["interrupted", projectId],
    queryFn: () => api.get<{ cards: number[] }>(`/api/state/interrupted?project=${encodeURIComponent(projectId)}`),
    refetchInterval: 5000,
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (discardedId === null) return;
    const timer = setTimeout(() => setDiscardedId(null), 6000);
    return () => clearTimeout(timer);
  }, [discardedId]);

  const invalidate = () => {
    setNotice(null);
    void qc.invalidateQueries({ queryKey: ["cards", projectId] });
    void qc.invalidateQueries({ queryKey: ["interrupted", projectId] });
    if (drawer) void qc.invalidateQueries({ queryKey: ["timeline", drawer.cardId] });
  };
  const fail = (_error: unknown) => setNotice("Action unavailable");
  const create = useMutation({
    mutationFn: (value: { title: string; agent: CardT["agent"] }) => api.post<CardT>(`/api/projects/${projectId}/cards`, { ...value, body: "" }),
    onSuccess: invalidate,
    onError: fail,
  });

  const grouped = useMemo(() => {
    const result: Record<BoardColumn, CardT[]> = { queue: [], running: [], waiting: [], review: [], done: [] };
    for (const card of cards.data ?? []) {
      const column = columnOf(card);
      if (column) result[column].push(card);
    }
    for (const column of COLUMNS) result[column.id].sort((a, b) => a.position - b.position || a.id - b.id);
    return result;
  }, [cards.data]);

  const activeSlots = (cards.data ?? []).filter(card => card.phase === "working" && (card.workingSub === "starting" || card.workingSub === "running")).length;
  const cancelledCount = (cards.data ?? []).filter(card => card.phase === "cancelled").length;
  const selected = drawer ? (cards.data ?? []).find(card => card.id === drawer.cardId) ?? null : null;

  const dropQueueCard = async (event: React.DragEvent<HTMLDivElement>, targetId: number) => {
    event.preventDefault();
    const sourceId = dragId ?? Number(event.dataTransfer.getData("text/plain"));
    setDragId(null);
    if (!Number.isInteger(sourceId) || sourceId === targetId) return;
    const queue = grouped.queue;
    const sourceIndex = queue.findIndex(card => card.id === sourceId);
    const targetIndex = queue.findIndex(card => card.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const source = queue[sourceIndex]!;
    const ordered = queue.filter(card => card.id !== sourceId);
    const targetWithoutSource = ordered.findIndex(card => card.id === targetId);
    const insertion = targetWithoutSource + (sourceIndex < targetIndex ? 1 : 0);
    ordered.splice(insertion, 0, source);
    const index = ordered.findIndex(card => card.id === sourceId);
    const before = ordered[index - 1];
    const after = ordered[index + 1];
    const position = before && after ? (before.position + after.position) / 2
      : before ? before.position + 1
      : after ? after.position - 1
      : source.position;
    try {
      await api.patch(`/api/projects/${projectId}/cards/${sourceId}/position`, { position });
      invalidate();
    } catch (error) {
      fail(error);
    }
  };

  const undoDiscard = async () => {
    if (discardedId === null) return;
    const id = discardedId;
    setDiscardedId(null);
    try {
      await api.post(`/api/cards/${id}/undo-discard`, {});
      invalidate();
    } catch (error) {
      fail(error);
    }
  };

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {notice && (
        <button type="button" onClick={() => setNotice(null)}
          style={{ position: "absolute", top: 10, left: 12, right: 12, zIndex: 30, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--red)", font: "inherit", fontSize: 11, textAlign: "left", cursor: "pointer" }}>
          {notice}
        </button>
      )}

      {(interrupted.data?.cards.length ?? 0) > 0 && (
        <div data-interrupted-banner style={{ display: "flex", alignItems: "center", gap: 7, margin: "12px 16px 0", padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--amber)", fontSize: 11 }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5 14 13H2Z"/><path d="M8 6.2v3.1M8 11.5h.01"/></svg>
          {interruptedMessage(interrupted.data!.cards.length)}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, padding: 16, alignItems: "flex-start", overflow: "auto", flex: 1 }}>
        {COLUMNS.map(column => {
          const list = grouped[column.id];
          return (
            <section key={column.id} data-board-column={column.id} style={{ flex: 1, minWidth: column.id === "waiting" ? 205 : 190 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 20, marginBottom: 10, color: "var(--dim)", fontSize: 10, fontWeight: 650, letterSpacing: ".8px" }}>
                {column.label}
                <span style={{ padding: "1px 7px", borderRadius: 999, background: "var(--surface-2)", color: "var(--meta)", fontSize: 9.5, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{list.length}</span>
                {column.id === "running" && <span data-slots style={{ marginLeft: "auto", padding: "1px 7px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--surface)", color: activeSlots >= project.workerLimit ? "var(--amber)" : "var(--green)", fontSize: 9.5, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{activeSlots}/{project.workerLimit}</span>}
              </div>
              {list.map((card, index) => {
                const terminal = cardRoutesToTerminal(card) ? terminalSessionForCard(card, sessions.data ?? []) : null;
                return <CardView key={card.id} card={card} column={column.id} now={now}
                  notice={cardNotices.get(card.id)}
                  queuePosition={column.id === "queue" ? index + 1 : undefined}
                  draggable={column.id === "queue"}
                  onDragStart={column.id === "queue" ? event => {
                    setDragId(card.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(card.id));
                  } : undefined}
                  onDragOver={column.id === "queue" ? event => {
                    if ((dragId !== null || event.dataTransfer.types.includes("text/plain")) && dragId !== card.id) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  } : undefined}
                  onDrop={column.id === "queue" ? event => void dropQueueCard(event, card.id) : undefined}
                  onDragEnd={() => setDragId(null)}
                  onOpenSession={terminal ? () => focusSession(terminal.id) : undefined}
                  onChanged={invalidate} onError={fail}
                  onDetails={sendBack => setDrawer({ cardId: card.id, sendBack: !!sendBack })}
                  onDiscarded={setDiscardedId} />;
              })}
              {column.id === "queue" && <Composer onCreate={(title, agent) => create.mutate({ title, agent })} />}
              {column.id === "done" && cancelledCount > 0 && (
                <div style={{ marginTop: 8, padding: "5px 8px", borderRadius: 6, background: "var(--surface)", color: "var(--dim)", fontSize: 10 }}>{cancelledCount} cancelled</div>
              )}
            </section>
          );
        })}
      </div>

      {selected && drawer && <Details card={selected} projectId={projectId} sendBack={drawer.sendBack} onSession={focusSession} onClose={() => setDrawer(null)} onChanged={invalidate} onError={fail} />}

      {discardedId !== null && (
        <div role="status" style={{ position: "absolute", right: 14, bottom: 14, zIndex: 35, display: "flex", alignItems: "center", gap: 12, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", boxShadow: "0 10px 30px var(--bg-deep)", color: "var(--text-2)", fontSize: 11 }}>
          Card discarded
          <button type="button" onClick={() => void undoDiscard()}
            style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--green)", font: "inherit", fontSize: 10, fontWeight: 500, cursor: "pointer" }}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({ onCreate }: { onCreate: (title: string, agent: CardT["agent"]) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState<CardT["agent"]>("claude");
  if (!open) return (
    <button type="button" onClick={() => setOpen(true)}
      style={{ width: "100%", padding: 7, border: "1px dashed var(--border)", borderRadius: 8, background: "var(--bg)", color: "var(--dim)", font: "inherit", fontSize: 11, textAlign: "center", cursor: "pointer" }}>
      + task
    </button>
  );
  return (
    <div style={{ padding: "10px 11px", border: "1px dashed var(--border)", borderRadius: 8 }}>
      <input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="What should be done?"
        onKeyDown={event => {
          if (event.key === "Enter" && title.trim()) { onCreate(title.trim(), agent); setTitle(""); setOpen(false); }
          if (event.key === "Escape") setOpen(false);
        }}
        style={{ width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 11 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
        {(["claude", "codex", "none"] as const).map(value => (
          <button key={value} type="button" onClick={() => setAgent(value)}
            style={{ padding: "3px 8px", border: `1px solid ${agent === value ? "var(--violet-2)" : "var(--border)"}`, borderRadius: 6, background: "var(--bg)", color: agent === value ? "var(--violet-2)" : "var(--ctrl)", font: "inherit", fontSize: 10, cursor: "pointer" }}>
            {value}
          </button>
        ))}
        <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: 10 }}>Enter → Queue</span>
      </div>
    </div>
  );
}
