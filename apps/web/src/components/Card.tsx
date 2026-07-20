import React, { useState } from "react";
import type { Card } from "@codegent/protocol";
import { api } from "../api";
import { formatElapsed, noticeCopy, type BoardColumn, type CardNoticeKind } from "../projection";

type Props = {
  card: Card;
  column: BoardColumn;
  now: number;
  queuePosition?: number;
  notice?: CardNoticeKind;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onOpenSession?: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
  onDetails: (sendBack?: boolean) => void;
  onDiscarded: (cardId: number) => void;
};

type IconName = "start" | "stop" | "question" | "permission" | "silent" | "error" | "review" | "details" | "resume" | "restart" | "discard" | "cancel" | "merge" | "send-back";

export function destructiveActionFor(card: Pick<Card, "phase">): "delete" | "cancel" | null {
  if (card.phase === "queued" || card.phase === "done") return "delete";
  if (card.phase === "working" || card.phase === "review") return "cancel";
  return null;
}

function Icon({ name, size = 11 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "start") return <svg {...common}><path d="M5 3.5 12 8l-7 4.5Z" /></svg>;
  if (name === "stop") return <svg {...common}><rect x="4" y="4" width="8" height="8" rx="1" /></svg>;
  if (name === "question") return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M6.5 6.2A1.7 1.7 0 0 1 8.2 4.8c1 0 1.8.6 1.8 1.5 0 1.5-2 1.5-2 3" /><path d="M8 11.7h.01" /></svg>;
  if (name === "permission") return <svg {...common}><path d="M8 2.5 13 4v3.7c0 2.8-2.1 4.8-5 5.8-2.9-1-5-3-5-5.8V4Z" /><path d="m5.8 8 1.4 1.4 3-3" /></svg>;
  if (name === "silent") return <svg {...common}><circle cx="8" cy="8" r="5.7" /><path d="M8 5v3.4l2.1 1.2" /></svg>;
  if (name === "error") return <svg {...common}><path d="M8 2.7 14 13H2Z" /><path d="M8 6.2v3.1M8 11.5h.01" /></svg>;
  if (name === "review") return <svg {...common}><path d="M3 8.2 6.3 11.5 13 4.8" /></svg>;
  if (name === "details") return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M8 7.2v3.5M8 5.1h.01" /></svg>;
  if (name === "resume") return <svg {...common}><path d="M4 3.3v4h4" /><path d="M4.4 7.1a4.8 4.8 0 1 1 .8 4.2" /></svg>;
  if (name === "restart") return <svg {...common}><path d="M12 3.3v4H8" /><path d="M11.6 7.1a4.8 4.8 0 1 0-.8 4.2" /></svg>;
  if (name === "discard") return <svg {...common}><path d="M3.5 4.5h9M6 4.5v-2h4v2M5 6.5l.5 6h5l.5-6" /></svg>;
  if (name === "cancel") return <svg {...common}><circle cx="8" cy="8" r="5.7" /><path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" /></svg>;
  if (name === "merge") return <svg {...common}><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="8" r="1.5" /><path d="M4 5v6M5.5 4.2C9 4.8 8.5 8 10.5 8" /></svg>;
  return <svg {...common}><path d="M3 4h6v4M9 4 3.5 9.5" /><path d="M6 12h7V5" /></svg>;
}

function Badge({ children, icon, color = "var(--meta)", metric = false }: { children: React.ReactNode; icon?: IconName; color?: string; metric?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minHeight: 19, padding: "1px 7px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--surface-2)", color, fontSize: 10, fontWeight: metric ? 500 : 650, fontVariantNumeric: metric ? "tabular-nums" : undefined, letterSpacing: ".45px", lineHeight: 1.2, textTransform: "uppercase" }}>
      {icon && <Icon name={icon} />}{children}
    </span>
  );
}

function ActionButton({ label, icon, onClick, disabled = false, tone = "var(--ctrl)" }: { label: string; icon: IconName; onClick: () => void; disabled?: boolean; tone?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, minHeight: 27, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: disabled ? "var(--dim)" : tone, font: "inherit", fontSize: 10, fontWeight: 500, cursor: disabled ? "default" : "pointer" }}>
      <Icon name={icon} />{label}
    </button>
  );
}

export function CardView({
  card, column, now, queuePosition, notice, draggable, onDragStart, onDragOver, onDrop, onDragEnd,
  onOpenSession, onChanged, onError, onDetails, onDiscarded,
}: Props) {
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const starting = card.phase === "working" && card.workingSub === "starting";
  const running = card.phase === "working" && card.workingSub === "running";
  const destructiveAction = destructiveActionFor(card);

  const action = async (name: "start" | "stop" | "resume" | "restart" | "discard" | "merge" | "cancel") => {
    setBusy(name);
    try {
      await api.post(`/api/cards/${card.id}/${name}`, {});
      onChanged();
      if (name === "discard") onDiscarded(card.id);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await api.del(`/api/cards/${card.id}`);
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async () => {
    setBusy("auto");
    try {
      await api.patch(`/api/cards/${card.id}/auto`, { auto: !card.auto });
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-card-id={card.id} data-column={column} data-terminal-route={onOpenSession ? true : undefined} draggable={draggable}
      onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
      tabIndex={onOpenSession ? 0 : undefined}
      onClick={onOpenSession ? event => {
        // Embedded actions keep their existing behavior; the task-language
        // card surface around them is the terminal deep-link target.
        if ((event.target as HTMLElement).closest?.("button, input, textarea, a")) return;
        onOpenSession();
      } : undefined}
      onKeyDown={onOpenSession ? event => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onOpenSession();
      } : undefined}
      onMouseLeave={() => setMenu(false)}
      style={{ position: "relative", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 11px", marginBottom: 8, opacity: card.phase === "done" ? .72 : 1, cursor: onOpenSession ? "pointer" : draggable ? "grab" : "default" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1, paddingRight: 16, color: "var(--text)", fontSize: 12, fontWeight: 500, lineHeight: 1.35, textDecoration: card.phase === "done" ? "line-through" : "none", overflowWrap: "anywhere" }}>{card.title}</div>
        <button type="button" aria-label="Card menu" onClick={() => setMenu(open => !open)}
          style={{ position: "absolute", top: 7, right: 7, display: "grid", placeItems: "center", width: 24, height: 24, padding: 0, border: 0, borderRadius: 6, background: "var(--surface)", color: "var(--dim)", cursor: "pointer" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
        {column === "queue" && <Badge>Queue · {queuePosition ?? 1}</Badge>}
        {column === "queue" && card.errorKind === "start_failed" && <Badge icon="error" color="var(--red)">Error</Badge>}
        {card.phase === "working" && card.workingSub === "error" && <Badge icon="error" color="var(--red)">Error</Badge>}
        {card.phase === "working" && card.workingSub === "stopped" && <Badge color="var(--meta)">Stopped</Badge>}
        {starting && <Badge color="var(--ctrl)">Starting</Badge>}
        {running && card.inputKind === null && <Badge color="var(--green)" metric>Running · {formatElapsed(now - card.updatedAt)}</Badge>}
        {running && card.inputKind === "question" && <Badge icon="question" color="var(--amber)">Question</Badge>}
        {running && card.inputKind === "permission" && <Badge icon="permission" color="var(--amber-soft)">Permission</Badge>}
        {running && card.inputKind === "silent" && <Badge icon="silent" color="var(--amber-dim)">Silent</Badge>}
        {running && card.inputKind !== null && <Badge color="var(--green)" metric>Running · {formatElapsed(now - card.updatedAt)}</Badge>}
        {card.phase === "working" && notice && <Badge color="var(--amber)">{noticeCopy(notice)}</Badge>}
        {card.round > 1 && card.phase !== "done" && <Badge color="var(--ctrl)">Round {card.round}</Badge>}
        {card.phase === "review" && card.reviewSub === "ready" && <Badge icon="review" color="var(--green)">Ready for review</Badge>}
        {card.phase === "review" && card.reviewSub !== "ready" && <Badge color="var(--ctrl)">{card.reviewSub ?? "Review"}</Badge>}
        {card.phase === "done" && <Badge icon="review" color="var(--green)">Done</Badge>}
        {card.agent !== "none" && <Badge color="var(--violet-2)">{card.agent}</Badge>}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
        {column === "queue" && (
          <button type="button" onClick={toggleAuto} disabled={busy !== null}
            style={{ minHeight: 27, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--bg)", color: card.auto ? "var(--green)" : "var(--meta)", font: "inherit", fontSize: 10, fontWeight: 500, cursor: busy ? "default" : "pointer" }}>
            Auto:{card.auto ? "on" : "off"}
          </button>
        )}
        {column === "queue" && <ActionButton label="Start" icon="start" tone="var(--green)" disabled={busy !== null || card.agent === "none"} onClick={() => void action("start")} />}
        {card.phase === "working" && card.workingSub === "running" && <ActionButton label="Stop" icon="stop" tone="var(--amber)" disabled={busy !== null} onClick={() => void action("stop")} />}
        {card.phase === "working" && card.workingSub === "stopped" && <ActionButton label="Resume" icon="resume" tone="var(--green)" disabled={busy !== null} onClick={() => void action("resume")} />}
        {card.phase === "working" && card.workingSub === "error" && (
          <>
            <ActionButton label="Resume" icon="resume" tone="var(--green)" disabled={busy !== null} onClick={() => void action("resume")} />
            <ActionButton label="Restart" icon="restart" disabled={busy !== null} onClick={() => void action("restart")} />
            <ActionButton label="Discard" icon="discard" tone="var(--red)" disabled={busy !== null} onClick={() => void action("discard")} />
          </>
        )}
        {card.phase === "review" && card.reviewSub === "ready" && (
          <>
            <ActionButton label="Merge" icon="merge" tone="var(--green)" disabled={busy !== null} onClick={() => void action("merge")} />
            <ActionButton label="Send back" icon="send-back" tone="var(--violet-2)" disabled={busy !== null} onClick={() => onDetails(true)} />
          </>
        )}
      </div>

      {menu && (
        <div style={{ position: "absolute", top: 29, right: 7, zIndex: 15, minWidth: 126, padding: 5, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", boxShadow: "0 10px 30px var(--bg-deep)" }}>
          <button type="button" onClick={() => { setMenu(false); onDetails(false); }}
            style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "6px 8px", border: 0, borderRadius: 6, background: "var(--surface)", color: "var(--text-2)", font: "inherit", fontSize: 11, cursor: "pointer", textAlign: "left" }}>
            <Icon name="details" />Details
          </button>
          {destructiveAction && (
            <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--hairline)" }}>
              <button type="button" disabled={busy !== null} onClick={() => {
                setMenu(false);
                if (destructiveAction === "delete") void remove();
                else void action("cancel");
              }}
                style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "6px 8px", border: 0, borderRadius: 6, background: "var(--surface)", color: busy ? "var(--dim)" : "var(--red)", font: "inherit", fontSize: 11, cursor: busy ? "default" : "pointer", textAlign: "left" }}>
                <Icon name={destructiveAction === "delete" ? "discard" : "cancel"} />
                {destructiveAction === "delete" ? "Delete" : "Cancel"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
