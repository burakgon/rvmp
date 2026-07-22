import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Card, SessionMeta } from "@rvmp/protocol";
import { api } from "../api";
import { railSessionEntries } from "../projection";

type TimelineEntry = {
  id: number;
  cardId: number;
  ts: number;
  kind: "progress" | "round" | "merge";
  text: string;
};

type Props = {
  card: Card;
  projectId: string;
  sendBack: boolean;
  onSession: (sessionId: string) => void;
  onClose: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
};

const stamp = (ts: number) => new Date(ts).toLocaleString("en-GB", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

const labelStyle: React.CSSProperties = {
  color: "var(--dim)", fontSize: 10, fontWeight: 650,
  letterSpacing: ".65px", textTransform: "uppercase",
};

const fieldStyle: React.CSSProperties = {
  width: "100%", padding: "7px 9px", border: "1px solid var(--border)",
  borderRadius: 6, outline: "none", background: "var(--bg)", color: "var(--text)",
  font: "inherit", fontSize: 11,
};

export function sendBackComments(value: string): string[] {
  const comment = value.trim();
  return comment ? [comment] : [];
}

export function Details({ card, projectId, sendBack, onSession, onClose, onChanged, onError }: Props) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [comments, setComments] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setTitle(card.title);
    setBody(card.body);
    setComments("");
  }, [card.id]);

  const timeline = useQuery({
    queryKey: ["timeline", card.id],
    queryFn: () => api.get<TimelineEntry[]>(`/api/cards/${card.id}/timeline`),
    refetchInterval: card.phase === "working" ? 2000 : false,
  });
  const sessions = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.get<SessionMeta[]>(`/api/projects/${projectId}/sessions`),
  });
  const history = useMemo(
    () => (sessions.data ?? []).filter(session => session.kind === "agent" && session.attemptId === card.attemptId).sort((a, b) => b.createdAt - a.createdAt),
    [sessions.data, card.attemptId],
  );
  const replayable = useMemo(
    () => new Set(railSessionEntries(sessions.data ?? [], [card]).filter(entry => entry.session.kind === "agent").map(entry => entry.session.id)),
    [sessions.data, card],
  );

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      // Binding obligation: Details writes title/body only. Orchestrator state
      // remains exclusively action-route owned.
      await api.patch(`/api/cards/${card.id}`, { title: title.trim(), body });
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const submitSendBack = async () => {
    setSending(true);
    try {
      await api.post(`/api/cards/${card.id}/send-back`, { comments: sendBackComments(comments) });
      onChanged();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside role="dialog" aria-modal="true" aria-label="Card details"
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, zIndex: 25, display: "flex", flexDirection: "column", width: 360, maxWidth: "100%", borderLeft: "1px solid var(--border)", background: "var(--bg-deep)", boxShadow: "-16px 0 32px var(--bg-deep)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--surface-2)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>Card details</div>
          <div style={{ marginTop: 2, color: "var(--meta)", fontSize: 10 }}>Card {card.id} · {card.phase}</div>
        </div>
        <button type="button" aria-label="Close details" onClick={onClose}
          style={{ display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--ctrl)", cursor: "pointer" }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
        <section>
          <div style={labelStyle}>Task</div>
          <input id="card-title" name="title" value={title} onChange={event => setTitle(event.target.value)} aria-label="Card title" style={{ ...fieldStyle, marginTop: 6 }} />
          <textarea id="card-body" name="body" value={body} onChange={event => setBody(event.target.value)} aria-label="Card body" rows={6}
            style={{ ...fieldStyle, display: "block", marginTop: 7, resize: "vertical", lineHeight: 1.5 }} />
          <button type="button" onClick={() => void save()} disabled={saving || !title.trim() || (title.trim() === card.title && body === card.body)}
            style={{ marginTop: 7, minHeight: 28, padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: saving ? "var(--dim)" : "var(--green)", font: "inherit", fontSize: 10, fontWeight: 500, cursor: saving ? "default" : "pointer" }}>
            {saving ? "Saving" : "Save details"}
          </button>
        </section>

        {sendBack && card.phase === "review" && card.reviewSub === "ready" && (
          <section style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--surface-2)" }}>
            <div style={labelStyle}>Send back</div>
            <textarea autoFocus value={comments} onChange={event => setComments(event.target.value)} aria-label="Review comments" rows={5} placeholder="Review comments"
              style={{ ...fieldStyle, display: "block", marginTop: 6, resize: "vertical", lineHeight: 1.5 }} />
            <button type="button" onClick={() => void submitSendBack()} disabled={sending}
              style={{ marginTop: 7, minHeight: 28, padding: "4px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: sending ? "var(--dim)" : "var(--violet-2)", font: "inherit", fontSize: 10, fontWeight: 500, cursor: sending ? "default" : "pointer" }}>
              {sending ? "Sending" : "Send comments"}
            </button>
          </section>
        )}

        <section style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--surface-2)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={labelStyle}>Timeline</div>
            <div style={{ color: "var(--dim)", fontSize: 10, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>{timeline.data?.length ?? 0} entries</div>
          </div>
          {timeline.isError && <div style={{ marginTop: 8, color: "var(--red)", fontSize: 11 }}>Timeline unavailable</div>}
          {!timeline.isError && (timeline.data?.length ?? 0) === 0 && <div style={{ marginTop: 8, color: "var(--dim)", fontSize: 11 }}>No timeline entries</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 9 }}>
            {(timeline.data ?? []).map(entry => (
              <div key={entry.id} style={{ padding: "8px 9px", border: "1px solid var(--hairline)", borderRadius: 8, background: "var(--surface)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ color: entry.kind === "progress" ? "var(--green)" : entry.kind === "round" ? "var(--violet-2)" : "var(--ctrl)", fontSize: 10, fontWeight: 650, letterSpacing: ".45px", textTransform: "uppercase" }}>{entry.kind}</span>
                  <span style={{ color: "var(--dim)", fontSize: 9.5, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>{stamp(entry.ts)}</span>
                </div>
                <div style={{ marginTop: 5, color: "var(--text-2)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.text}</div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--surface-2)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={labelStyle}>Session history</div>
            <div style={{ color: "var(--dim)", fontSize: 10, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>Attempt {card.attemptId ?? "—"}</div>
          </div>
          {sessions.isError && <div style={{ marginTop: 8, color: "var(--red)", fontSize: 11 }}>Sessions unavailable</div>}
          {!sessions.isError && history.length === 0 && <div style={{ marginTop: 8, color: "var(--dim)", fontSize: 11 }}>No agent sessions</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }}>
            {history.map((session, index) => {
              const content = (
                <>
                  <span style={{ color: "var(--ctrl)", fontSize: 10, fontWeight: 650, letterSpacing: ".4px" }}>SESSION {history.length - index}</span>
                  <span style={{ marginLeft: "auto", color: session.live ? "var(--green)" : "var(--meta)", fontSize: 10, fontWeight: 650 }}>{session.live ? "LIVE" : "ENDED"}</span>
                  <span style={{ color: "var(--dim)", fontSize: 9.5, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>{stamp(session.createdAt)}</span>
                </>
              );
              const style: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 9px", border: "1px solid var(--hairline)", borderRadius: 8, background: "var(--surface)", font: "inherit", textAlign: "left" };
              return replayable.has(session.id) ? (
                <button key={session.id} type="button" data-session-link={session.id} aria-label={`Open session ${history.length - index}`} onClick={() => onSession(session.id)}
                  style={{ ...style, cursor: "pointer" }}>
                  {content}
                </button>
              ) : (
                <div key={session.id} style={style}>{content}</div>
              );
            })}
          </div>
        </section>
      </div>
    </aside>
  );
}
