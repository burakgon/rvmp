import React, { useContext, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Card, DiffFile, DiffPayload, DiffSummary, SessionMeta, Worktree } from "@codegent/protocol";
import { api } from "../api";
import { formatElapsed, reviewQueueOrder } from "../projection";
import { AppCtx } from "../appCtx";

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
    <span data-queue-pill={card.id} onClick={onSelect}
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
  const seen = files.filter(f => viewed.has(f.path)).length;
  return (
    <div data-files-panel style={{ width: 250, flexShrink: 0, borderRight: "1px solid var(--surface-2)", overflow: "auto" }}>
      <div style={{ padding: "8px 12px 6px", position: "sticky", top: 0, background: "var(--bg-deep)" }}>
        <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", textTransform: "uppercase" }}>
          Files <span style={{ fontWeight: 500 }}>{seen}/{files.length} reviewed</span>
        </div>
        <div style={{ height: 2, marginTop: 5, borderRadius: 999, background: "var(--surface-2)" }}>
          <div style={{ height: 2, width: `${files.length ? (seen / files.length) * 100 : 0}%`, borderRadius: 999, background: "var(--violet)" }} />
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

/** Pure unified hunk renderer (exported for tests). */
export function HunkList({ file, anchorId }: { file: DiffFile; anchorId: string }) {
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
          {h.lines.map((l, li) => (
            <div key={li} data-line-t={l.t} style={{ display: "flex", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5,
              background: l.t === "add" ? "color-mix(in srgb, var(--git-green) 9%, transparent)" : l.t === "del" ? "color-mix(in srgb, var(--git-red) 9%, transparent)" : "transparent" }}>
              <span style={{ width: 42, flexShrink: 0, textAlign: "right", paddingRight: 7, color: "var(--dim)", fontVariantNumeric: "tabular-nums", userSelect: "none" }}>{l.oldNo ?? ""}</span>
              <span style={{ width: 42, flexShrink: 0, textAlign: "right", paddingRight: 9, color: "var(--dim)", fontVariantNumeric: "tabular-nums", userSelect: "none" }}>{l.newNo ?? ""}</span>
              <span style={{ width: 13, flexShrink: 0, color: l.t === "add" ? "var(--git-green)" : l.t === "del" ? "var(--git-red)" : "var(--dim)", userSelect: "none" }}>{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>
              <span style={{ whiteSpace: "pre", color: "var(--text-2)" }}>{l.text}</span>
            </div>
          ))}
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
  const now = Date.now();

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
  const sendBack = () => {
    const comment = sendBackText.trim();
    act.mutate({ path: `/api/cards/${sel!.id}/send-back`, body: { comments: comment ? [comment] : [] } });
    setSendBackOpen(false);
    setSendBackText("");
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
          {!readOnly && (
            <button type="button" style={btn("var(--violet-2)", act.isPending)} disabled={act.isPending} onClick={() => setSendBackOpen(v => !v)}>
              Send back{sendBackText.trim() ? " · 1" : ""}
            </button>
          )}
          {!readOnly && (sel.prNumber === null ? (
            <button type="button" style={btn("var(--ctrl)", act.isPending || sel.reviewSub === "merging")} disabled={act.isPending || sel.reviewSub === "merging"}
              onClick={() => act.mutate({ path: `/api/cards/${sel.id}/pr` })}>
              Open PR
            </button>
          ) : (
            <a href={sel.prUrl ?? "#"} target="_blank" rel="noreferrer"
              style={{ ...btn("var(--violet-2)"), textDecoration: "none" }}>
              PR #{sel.prNumber}
              {sel.ciStatus && <span style={{ width: 7, height: 7, borderRadius: 999, background: sel.ciStatus === "pass" ? "var(--green)" : sel.ciStatus === "fail" ? "var(--red)" : "var(--amber)" }} />}
            </a>
          ))}
          {!readOnly && (
            <button type="button" data-merge-button title={sel.reviewSub === "stale" ? "behind base — update first" : sel.reviewSub === "conflict" ? "resolve the conflict first" : undefined}
              style={btn("var(--green)", mergeDisabled && sel.reviewSub !== "stale")}
              disabled={mergeDisabled && sel.reviewSub !== "stale"}
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

      {sendBackOpen && !readOnly && (
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
        {diff.data ? (
          <>
            <FilesPanel files={diff.data.files} viewed={viewedSet} readOnly={readOnly}
              onToggle={(path, value) => toggleViewed.mutate({ path, viewed: value })}
              onJump={i => document.getElementById(`diff-f-${sel.id}-${i}`)?.scrollIntoView({ behavior: "smooth" })} />
            <div data-diff-mode={viewMode} style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
              {diff.data.files.length === 0 && <div style={{ padding: 20, fontSize: 11, color: "var(--dim)" }}>no changes against {diff.data.base}</div>}
              {diff.data.files.map((f, i) => <HunkList key={f.path} file={f} anchorId={`diff-f-${sel.id}-${i}`} />)}
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
