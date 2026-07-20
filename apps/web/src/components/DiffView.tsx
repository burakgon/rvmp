import React, { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card, DiffFile, DiffPayload, DiffSummary, SessionMeta, Worktree } from "@codegent/protocol";
import { api } from "../api";
import { formatElapsed, reviewQueueOrder } from "../projection";
import { AppCtx } from "../appCtx";
import {
  clearComments, commentsFor, commentsVersion, deleteComment, editComment,
  queueComment, serializeComments, subscribeComments, type QueuedComment,
} from "../comments";

// §7.5 Diff — review queue strip · header · files panel · unified hunks.
// Diff data is REPO content the user owns, never terminal output. Everything
// obeys the grammar: 9.5-13px, weights ≤500 (650 tiny-caps), radii 6/8/999,
// var(--…) tokens, inline SVG, no emoji.

type MergeMode = "squash" | "merge" | "rebase";

const btn = (tone: string, disabled = false): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 5, minHeight: 27, padding: "4px 9px",
  border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)",
  color: disabled ? "var(--dim)" : tone, font: "inherit", fontSize: 10, fontWeight: 500,
  cursor: disabled ? "default" : "pointer",
});

/** Pure strip pill (exported for tests): dot · title · ready-since · stat. */
export function QueuePill({ card, summary, active, now, onSelect, onUpdate }: {
  card: Card; summary: DiffSummary | null; active: boolean; now: number;
  onSelect: () => void; onUpdate?: () => void;
}) {
  const tone = card.reviewSub === "conflict" ? "var(--red)" : card.reviewSub === "stale" ? "var(--amber)" : "var(--green)";
  return (
    <span data-queue-pill={card.id} role="button" tabIndex={0} onClick={onSelect}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "4px 10px", borderRadius: 999,
        border: `1px solid ${active ? "var(--violet-2)" : "var(--border)"}`,
        background: active ? "var(--surface-2)" : "var(--surface)", cursor: "pointer", whiteSpace: "nowrap" }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: tone }} />
      <span style={{ fontSize: 11, color: "var(--text)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{card.title}</span>
      {card.readySince !== null && <span style={{ fontSize: 9.5, color: "var(--meta)", fontVariantNumeric: "tabular-nums" }}>{formatElapsed(now - card.readySince)}</span>}
      {summary && (
        <span style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums" }}>
          <span style={{ color: "var(--git-green)" }}>+{summary.additions}</span>{" "}
          <span style={{ color: "var(--git-red)" }}>−{summary.deletions}</span>
        </span>
      )}
      {card.reviewSub === "stale" && onUpdate && (
        <button type="button" onClick={e => { e.stopPropagation(); onUpdate(); }}
          style={{ padding: "1px 7px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--bg)", color: "var(--amber)", font: "inherit", fontSize: 9.5, fontWeight: 500, cursor: "pointer" }}>
          update
        </button>
      )}
      {card.reviewSub === "conflict" && <span style={{ fontSize: 9.5, color: "var(--red)", fontWeight: 500 }}>conflict</span>}
    </span>
  );
}

/** Pure files panel (exported for tests): status letters, ±, viewed marks. */
export function FilesPanel({ files, viewed, readOnly, onToggle, onJump }: {
  files: DiffFile[]; viewed: ReadonlySet<string>; readOnly: boolean;
  onToggle: (path: string, value: boolean) => void; onJump: (index: number) => void;
}) {
  const reviewable = files.filter(f => !f.binary && !f.truncated);
  const seen = reviewable.filter(f => viewed.has(f.path)).length;
  return (
    <div data-files-panel style={{ width: 250, flexShrink: 0, borderRight: "1px solid var(--surface-2)", overflow: "auto" }}>
      <div style={{ padding: "8px 12px 6px", position: "sticky", top: 0, background: "var(--bg-deep)" }}>
        <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", textTransform: "uppercase" }}>
          Files <span style={{ fontWeight: 500 }}>{seen}/{reviewable.length} reviewed</span>
        </div>
        <div style={{ height: 2, marginTop: 5, borderRadius: 999, background: "var(--surface-2)" }}>
          <div style={{ height: 2, width: `${reviewable.length ? (seen / reviewable.length) * 100 : 0}%`, borderRadius: 999, background: "var(--violet)" }} />
        </div>
      </div>
      {files.map((f, i) => (
        <div key={f.path} data-file-row={f.path} onClick={() => onJump(i)}
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 12px", cursor: "pointer", opacity: viewed.has(f.path) ? .55 : 1 }}>
          <span style={{ width: 12, fontSize: 10, fontWeight: 650, color: f.status === "D" ? "var(--git-red)" : f.status === "A" ? "var(--git-green)" : "var(--ctrl)" }}>{f.status}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: viewed.has(f.path) ? "line-through" : "none" }}>
            {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          </span>
          <span style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums", color: "var(--meta)" }}>
            <span style={{ color: "var(--git-green)" }}>+{f.additions}</span> <span style={{ color: "var(--git-red)" }}>−{f.deletions}</span>
          </span>
          {f.binary || f.truncated ? (
            <span style={{ fontSize: 9.5, color: "var(--dim)" }}>{f.binary ? "bin" : "large"}</span>
          ) : (
            <input type="checkbox" aria-label={`Mark ${f.path} reviewed`} checked={viewed.has(f.path)} disabled={readOnly}
              onClick={e => e.stopPropagation()}
              onChange={e => onToggle(f.path, e.target.checked)} />
          )}
        </div>
      ))}
    </div>
  );
}

type DiffLine = DiffFile["hunks"][number]["lines"][number];

/** Pair del/add runs into old|new columns for the split view (exported for tests). */
export function splitRows(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.t === "del") dels.push(l);
    else if (l.t === "add") adds.push(l);
    else {
      flush();
      rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

/** A queued comment anchors to the new-side line (old side for deletions). */
export const commentAnchor = (l: DiffLine): number | null => (l.t === "del" ? l.oldNo : l.newNo);

const lineBg = (t: DiffLine["t"] | undefined): string =>
  t === "add" ? "color-mix(in srgb, var(--git-green) 9%, transparent)"
  : t === "del" ? "color-mix(in srgb, var(--git-red) 9%, transparent)"
  : "transparent";

function CommentRow({ comment, readOnly, onEdit, onDelete }: {
  comment: QueuedComment; readOnly: boolean;
  onEdit: (id: string, text: string) => void; onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div data-queued-comment={comment.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "2px 12px 4px 97px", padding: "6px 9px", border: "1px solid var(--violet-2)", borderRadius: 6, background: "var(--surface)" }}>
      {editing === null ? (
        <>
          <span style={{ flex: 1, fontSize: 11, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>{comment.text}</span>
          <span style={{ fontSize: 9.5, color: "var(--violet-2)", fontWeight: 500 }}>queued</span>
          {!readOnly && (
            <>
              <button type="button" onClick={() => setEditing(comment.text)}
                style={{ padding: 0, border: 0, background: "none", color: "var(--ctrl)", font: "inherit", fontSize: 9.5, cursor: "pointer" }}>edit</button>
              <button type="button" onClick={() => onDelete(comment.id)}
                style={{ padding: 0, border: 0, background: "none", color: "var(--red)", font: "inherit", fontSize: 9.5, cursor: "pointer" }}>delete</button>
            </>
          )}
        </>
      ) : (
        <input autoFocus value={editing} onChange={e => setEditing(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { onEdit(comment.id, editing); setEditing(null); }
            if (e.key === "Escape") setEditing(null);
          }}
          onBlur={() => { onEdit(comment.id, editing); setEditing(null); }}
          style={{ flex: 1, padding: "3px 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 11, outline: "none" }} />
      )}
    </div>
  );
}

/** Hunk renderer (exported for tests): unified with hover-`+` line comments,
 * or a two-column split (view-only — comments queue from unified). */
export function HunkList({ file, anchorId, mode = "unified", comments = [], readOnly = true, onQueue, onEdit, onDelete }: {
  file: DiffFile; anchorId: string; mode?: "unified" | "split";
  comments?: QueuedComment[]; readOnly?: boolean;
  onQueue?: (line: number | null, del: boolean, text: string) => void;
  onEdit?: (id: string, text: string) => void;
  onDelete?: (id: string) => void;
}) {
  const [composer, setComposer] = useState<{ key: string; line: number | null; del: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const num = (v: number | null): React.CSSProperties => ({ width: 42, flexShrink: 0, textAlign: "right", paddingRight: 7, color: "var(--dim)", fontVariantNumeric: "tabular-nums", userSelect: "none" });
  const commit = () => {
    if (composer && onQueue) onQueue(composer.line, composer.del, draft);
    setComposer(null);
    setDraft("");
  };
  const commentsAt = (l: DiffLine) =>
    comments.filter(c => c.line === commentAnchor(l) && c.del === (l.t === "del"));

  return (
    <div id={anchorId} data-diff-file={file.path} style={{ marginBottom: 18 }}>
      <div style={{ position: "sticky", top: 0, zIndex: 5, display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "var(--surface)", borderTop: "1px solid var(--surface-2)", borderBottom: "1px solid var(--surface-2)" }}>
        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{f2title(file)}</span>
        <span style={{ fontSize: 9.5, fontVariantNumeric: "tabular-nums", color: "var(--meta)" }}>
          <span style={{ color: "var(--git-green)" }}>+{file.additions}</span> <span style={{ color: "var(--git-red)" }}>−{file.deletions}</span>
        </span>
      </div>
      {(file.binary || file.truncated) ? (
        <div style={{ padding: "14px 12px", fontSize: 11, color: "var(--dim)" }}>
          {file.binary ? "binary file" : "file too large"} — open the worktree terminal to inspect it
        </div>
      ) : file.hunks.map((h, hi) => (
        <div key={hi}>
          <div style={{ padding: "3px 12px", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--cyan)", background: "var(--bg)" }}>{h.header}</div>
          {mode === "split" ? (
            splitRows(h.lines).map((row, ri) => (
              <div key={ri} data-split-row style={{ display: "flex", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5 }}>
                <div style={{ display: "flex", flex: 1, minWidth: 0, background: lineBg(row.left?.t === "ctx" ? "ctx" : row.left ? "del" : undefined), borderRight: "1px solid var(--surface-2)" }}>
                  <span style={num(row.left?.oldNo ?? null)}>{row.left?.oldNo ?? ""}</span>
                  <span style={{ whiteSpace: "pre", color: "var(--text-2)", overflow: "hidden" }}>{row.left?.text ?? ""}</span>
                </div>
                <div style={{ display: "flex", flex: 1, minWidth: 0, background: lineBg(row.right?.t === "ctx" ? "ctx" : row.right ? "add" : undefined) }}>
                  <span style={num(row.right?.newNo ?? null)}>{row.right?.newNo ?? ""}</span>
                  <span style={{ whiteSpace: "pre", color: "var(--text-2)", overflow: "hidden" }}>{row.right?.text ?? ""}</span>
                </div>
              </div>
            ))
          ) : (
            h.lines.map((l, li) => {
              const key = `${hi}-${li}`;
              const anchored = commentsAt(l);
              return (
                <React.Fragment key={key}>
                  <div data-line-t={l.t} className="diff-line" style={{ display: "flex", alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, background: lineBg(l.t) }}>
                    <span style={num(l.oldNo)}>{l.oldNo ?? ""}</span>
                    <span style={num(l.newNo)}>{l.newNo ?? ""}</span>
                    <span style={{ width: 13, flexShrink: 0, color: l.t === "add" ? "var(--git-green)" : l.t === "del" ? "var(--git-red)" : "var(--dim)", userSelect: "none" }}>{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>
                    {!readOnly && onQueue && (
                      <button type="button" aria-label={`Comment on line ${commentAnchor(l) ?? ""}`} className="diff-plus"
                        onClick={() => { setComposer({ key, line: commentAnchor(l), del: l.t === "del" }); setDraft(""); }}
                        style={{ width: 15, height: 15, marginRight: 4, padding: 0, border: "1px solid var(--violet-2)", borderRadius: 6, background: "var(--bg)", color: "var(--violet-2)", fontSize: 10, lineHeight: 1, cursor: "pointer", flexShrink: 0 }}>+</button>
                    )}
                    <span style={{ whiteSpace: "pre", color: "var(--text-2)" }}>{l.text}</span>
                  </div>
                  {composer?.key === key && (
                    <div style={{ display: "flex", gap: 6, margin: "2px 12px 4px 97px" }}>
                      <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} placeholder="Queue a comment for this line"
                        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setComposer(null); }}
                        style={{ flex: 1, padding: "5px 8px", border: "1px solid var(--violet-2)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 11, outline: "none" }} />
                      <button type="button" onClick={commit} style={btn("var(--violet-2)")}>Queue</button>
                    </div>
                  )}
                  {anchored.map(c => (
                    <CommentRow key={c.id} comment={c} readOnly={readOnly}
                      onEdit={(id, text) => onEdit?.(id, text)} onDelete={id => onDelete?.(id)} />
                  ))}
                </React.Fragment>
              );
            })
          )}
        </div>
      ))}
    </div>
  );
}

const f2title = (f: DiffFile) => (f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);

/** Strip pill with its own summary hydration (one small query per pill). */
function StripPill({ card, active, now, onSelect, onUpdate }: {
  card: Card; active: boolean; now: number; onSelect: () => void; onUpdate: () => void;
}) {
  const summary = useQuery({
    queryKey: ["diffsum", card.id],
    queryFn: () => api.get<DiffSummary>(`/api/cards/${card.id}/diff?summary=1`),
    staleTime: 15_000,
  });
  return <QueuePill card={card} summary={summary.data ?? null} active={active} now={now} onSelect={onSelect} onUpdate={onUpdate} />;
}

export function DiffView() {
  const { projectId, diffFocus, focusDiff, focusSession } = useContext(AppCtx);
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [mergeMenu, setMergeMenu] = useState(false);
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [sendBackText, setSendBackText] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const cards = useQuery({ queryKey: ["cards", projectId], queryFn: () => api.get<Card[]>(`/api/projects/${projectId}/cards`) });
  const worktrees = useQuery({ queryKey: ["worktrees", projectId], queryFn: () => api.get<Worktree[]>(`/api/projects/${projectId}/worktrees`) });

  const queue = useMemo(
    () => (cards.data ?? []).filter(c => c.phase === "review").sort(reviewQueueOrder),
    [cards.data],
  );
  const focused = (cards.data ?? []).find(c => c.id === diffFocus) ?? null;
  // Focused card wins (review or done); otherwise the queue head.
  const sel = focused && (focused.phase === "review" || focused.phase === "done") ? focused : queue[0] ?? null;
  const readOnly = sel?.phase === "done";
  const wt = sel?.worktreeId ? (worktrees.data ?? []).find(w => w.id === sel.worktreeId) ?? null : null;

  const diff = useQuery({
    queryKey: ["diff", sel?.id],
    enabled: sel !== null,
    queryFn: () => api.get<DiffPayload>(`/api/cards/${sel!.id}/diff`),
  });
  const reviewed = useQuery({
    queryKey: ["reviewed", sel?.id],
    enabled: sel !== null,
    queryFn: () => api.get<{ paths: string[] }>(`/api/cards/${sel!.id}/reviewed-files`),
  });
  const viewedSet = useMemo(() => new Set(reviewed.data?.paths ?? []), [reviewed.data]);

  // Drafts and menus are PER-CARD scratch: switching pills must never carry
  // card A's note into card B's batch (review B5).
  useEffect(() => {
    setSendBackOpen(false);
    setSendBackText("");
    setMergeMenu(false);
  }, [sel?.id]);
  // Missed-event reconciliation (verify R-M3): if a selected card is already
  // terminal (socket dropped the done/cancelled event), purge its queue here.
  useEffect(() => {
    if (sel && (sel.phase === "done" || sel.phase === "cancelled")) clearComments(sel.id);
  }, [sel?.id, sel?.phase]);

  useSyncExternalStore(subscribeComments, commentsVersion, commentsVersion);

  const queued = sel === null ? [] : commentsFor(sel.id);

  const invalidate = () => {
    setNotice(null);
    void qc.invalidateQueries({ queryKey: ["cards", projectId] });
    void qc.invalidateQueries({ queryKey: ["diff"] });
    void qc.invalidateQueries({ queryKey: ["diffsum"] });
    void qc.invalidateQueries({ queryKey: ["reviewed"] });
  };
  const fail = (error: unknown) => setNotice(error instanceof Error ? error.message : "Action unavailable");

  const act = useMutation({
    mutationFn: async (input: { path: string; body?: unknown }) => api.post(input.path, input.body ?? {}),
    onSuccess: invalidate,
    onError: fail,
  });
  const toggleViewed = useMutation({
    mutationFn: (input: { path: string; viewed: boolean }) => api.put(`/api/cards/${sel!.id}/reviewed-files`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reviewed", sel?.id] }),
    onError: fail,
  });

  const openWorktreeTerminal = async () => {
    if (!wt) return;
    try {
      const meta = await api.post<SessionMeta>(`/api/projects/${projectId}/sessions`, {
        title: wt.branch, cwd: wt.path, worktreeId: wt.id,
      });
      focusSession(meta.id);
    } catch (error) {
      fail(error);
    }
  };

  const mergeAs = (mode: MergeMode) => {
    setMergeMenu(false);
    act.mutate({ path: `/api/cards/${sel!.id}/merge`, body: { mode } });
  };
  const updateThenMerge = async () => {
    setMergeMenu(false);
    try {
      await api.post(`/api/cards/${sel!.id}/update`, {});
      await api.post(`/api/cards/${sel!.id}/merge`, { mode: "squash" });
      invalidate();
    } catch (error) {
      fail(error);
      invalidate(); // partial success (updated but conflicted) must render truthfully
    }
  };
  const sendBack = async () => {
    if (sel?.reviewSub !== "ready") return; // card moved under the composer (verify R-M2)
    // One batch: every queued line comment (file:line-prefixed) + the general
    // note. The queue clears ONLY on success — a 409 (stale/conflict) must
    // never eat the reviewer's comments (review B4).
    try {
      await api.post(`/api/cards/${sel!.id}/send-back`, { comments: serializeComments(sel!.id, sendBackText) });
      clearComments(sel!.id);
      setSendBackOpen(false);
      setSendBackText("");
      invalidate();
    } catch (error) {
      fail(error);
    }
  };

  if (!sel) {
    return <div style={{ display: "grid", placeItems: "center", flex: 1, color: "var(--dim)", fontSize: 12 }}>nothing to review</div>;
  }

  const mergeDisabled = readOnly || sel.reviewSub !== "ready" || act.isPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {notice && (
        <button type="button" onClick={() => setNotice(null)}
          style={{ margin: "8px 12px 0", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--surface)", color: "var(--red)", font: "inherit", fontSize: 11, textAlign: "left", cursor: "pointer" }}>
          {notice}
        </button>
      )}

      {/* review queue strip */}
      <div data-queue-strip style={{ display: "flex", gap: 7, padding: "10px 12px", overflowX: "auto", borderBottom: "1px solid var(--surface-2)" }}>
        {queue.map(c => (
          <StripPill key={c.id} card={c} active={c.id === sel.id} now={now}
            onSelect={() => focusDiff(c.id)}
            onUpdate={() => act.mutate({ path: `/api/cards/${c.id}/update` })} />
        ))}
        {queue.length === 0 && readOnly && <span style={{ fontSize: 10, color: "var(--dim)", alignSelf: "center" }}>queue empty</span>}
      </div>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid var(--surface-2)", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{sel.title}</div>
          {wt && <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--meta)" }}>{wt.branch} ← {wt.base}</div>}
        </div>
        {diff.data && (
          <span style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
            <span style={{ color: "var(--git-green)" }}>+{diff.data.additions}</span>{" "}
            <span style={{ color: "var(--git-red)" }}>−{diff.data.deletions}</span>
          </span>
        )}
        {readOnly && <span style={{ padding: "1px 8px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-2)", fontSize: 10, color: "var(--meta)" }}>merged {new Date(sel.updatedAt).toLocaleDateString("en-US")}</span>}
        {sel.reviewSub === "conflict" && (
          <span style={{ padding: "2px 9px", borderRadius: 6, border: "1px solid var(--red)", color: "var(--red)", fontSize: 10, fontWeight: 500 }}>
            conflict — resolve in the worktree terminal
          </span>
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", position: "relative" }}>
          <div style={{ display: "flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
            {(["unified", "split"] as const).map(m => (
              <span key={m} onClick={() => setViewMode(m)}
                style={{ padding: "3px 9px", borderRadius: 6, cursor: "pointer", fontSize: 10,
                  background: viewMode === m ? "var(--violet)" : "transparent",
                  color: viewMode === m ? "var(--text-on-accent)" : "var(--ctrl)" }}>
                {m[0].toUpperCase() + m.slice(1)}
              </span>
            ))}
          </div>
          {wt && (
            <button type="button" style={btn("var(--ctrl)")} onClick={() => void openWorktreeTerminal()}>
              <TermIcon />terminal
            </button>
          )}
          {!readOnly && (() => {
            const n = queued.length + (sendBackText.trim() ? 1 : 0);
            const illegal = sel.reviewSub !== "ready";
            return (
              <button type="button" data-send-back-count={n} title={illegal ? "send back needs a ready review" : undefined} style={btn("var(--violet-2)", act.isPending || illegal)} disabled={act.isPending || illegal} onClick={() => setSendBackOpen(v => !v)}>
                Send back{n > 0 ? ` · ${n}` : ""}
              </button>
            );
          })()}
          {!readOnly && sel.prNumber === null && (
            <button type="button" style={btn("var(--ctrl)", act.isPending || sel.reviewSub === "merging")} disabled={act.isPending || sel.reviewSub === "merging"}
              onClick={() => act.mutate({ path: `/api/cards/${sel.id}/pr` })}>
              Open PR
            </button>
          )}
          {sel.prNumber !== null && (
            <a href={sel.prUrl ?? "#"} target="_blank" rel="noreferrer"
              style={{ ...btn("var(--violet-2)"), textDecoration: "none" }}>
              PR #{sel.prNumber}
              {sel.ciStatus && <span role="img" aria-label={`CI ${sel.ciStatus}`} style={{ width: 7, height: 7, borderRadius: 999, background: sel.ciStatus === "pass" ? "var(--green)" : sel.ciStatus === "fail" ? "var(--red)" : "var(--amber)" }} />}
            </a>
          )}
          {!readOnly && (
            <button type="button" data-merge-button title={sel.reviewSub === "stale" ? "behind base — update first" : sel.reviewSub === "conflict" ? "resolve the conflict first" : undefined}
              style={btn("var(--green)", act.isPending || (mergeDisabled && sel.reviewSub !== "stale"))}
              disabled={act.isPending || (mergeDisabled && sel.reviewSub !== "stale")}
              onClick={() => setMergeMenu(v => !v)}>
              Merge ▾
            </button>
          )}
          {mergeMenu && (
            <div style={{ position: "absolute", top: 32, right: 0, zIndex: 20, minWidth: 168, padding: 5, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", boxShadow: "0 10px 30px var(--bg-deep)" }}>
              {sel.reviewSub === "ready" && (["squash", "merge", "rebase"] as MergeMode[]).map(m => (
                <button key={m} type="button" onClick={() => mergeAs(m)}
                  style={{ display: "block", width: "100%", padding: "6px 9px", border: 0, borderRadius: 6, background: "var(--surface)", color: "var(--text-2)", font: "inherit", fontSize: 11, cursor: "pointer", textAlign: "left" }}>
                  {m}{m === "squash" ? " (default)" : ""}
                </button>
              ))}
              {sel.reviewSub === "stale" && (
                <button type="button" onClick={() => void updateThenMerge()}
                  style={{ display: "block", width: "100%", padding: "6px 9px", border: 0, borderRadius: 6, background: "var(--surface)", color: "var(--amber)", font: "inherit", fontSize: 11, cursor: "pointer", textAlign: "left" }}>
                  Update, then merge
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {sendBackOpen && !readOnly && sel.reviewSub === "ready" && (
        <div style={{ display: "flex", gap: 7, padding: "8px 12px", borderBottom: "1px solid var(--surface-2)" }}>
          <input autoFocus value={sendBackText} onChange={e => setSendBackText(e.target.value)}
            placeholder="What should change? (sent to the agent)"
            onKeyDown={e => { if (e.key === "Enter") sendBack(); if (e.key === "Escape") setSendBackOpen(false); }}
            style={{ flex: 1, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 11, outline: "none" }} />
          <button type="button" style={btn("var(--violet-2)")} onClick={sendBack}>Send</button>
        </div>
      )}

      {/* body: files + code */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {diff.data && !diff.isError ? (
          <>
            <FilesPanel files={diff.data.files} viewed={viewedSet} readOnly={readOnly}
              onToggle={(path, value) => toggleViewed.mutate({ path, viewed: value })}
              onJump={i => document.getElementById(`diff-f-${sel.id}-${i}`)?.scrollIntoView({ behavior: "smooth" })} />
            <div data-diff-mode={viewMode} style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
              {diff.data.files.length === 0 && <div style={{ padding: 20, fontSize: 11, color: "var(--dim)" }}>no changes against {diff.data.base}</div>}
              {diff.data.files.map((f, i) => (
                <HunkList key={f.path} file={f} anchorId={`diff-f-${sel.id}-${i}`} mode={viewMode}
                  comments={queued.filter(c => c.path === f.path)} readOnly={readOnly}
                  onQueue={(line, del, text) => queueComment(sel.id, { path: f.path, line, del, text })}
                  onEdit={(id, text) => editComment(sel.id, id, text)}
                  onDelete={id => deleteComment(sel.id, id)} />
              ))}
            </div>
          </>
        ) : (
          <div style={{ display: "grid", placeItems: "center", flex: 1, color: "var(--dim)", fontSize: 11 }}>
            {diff.isError ? "diff unavailable" : "computing diff…"}
          </div>
        )}
      </div>
    </div>
  );
}

function TermIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="m4.8 6.5 2 1.7-2 1.7M8.6 10.2h2.6" />
    </svg>
  );
}
