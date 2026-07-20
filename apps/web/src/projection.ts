import type { Card, DomainEvent, SessionMeta } from "@codegent/protocol";

export type BoardColumn = "queue" | "running" | "waiting" | "review" | "done";
export type CardNoticeKind = Extract<DomainEvent, { t: "notice" }>["kind"];
export type CardNoticeState = ReadonlyMap<number, CardNoticeKind>;

/** Ordered event projection for fixed-copy card notices. Any newer card event
 * is fresher truth and clears its notice, even if the card remains working;
 * leaving working therefore clears through the same rule. */
export function reduceCardNotices(state: CardNoticeState, event: DomainEvent): CardNoticeState {
  if (event.t === "notice") {
    if (state.get(event.cardId) === event.kind) return state;
    const next = new Map(state);
    next.set(event.cardId, event.kind);
    return next;
  }
  if (event.t === "notice-clear") {
    if (state.get(event.cardId) !== event.kind) return state;
    const next = new Map(state);
    next.delete(event.cardId);
    return next;
  }
  const cardId = event.t === "card" ? event.card.id : event.t === "cardDeleted" ? event.id : null;
  if (cardId === null || !state.has(cardId)) return state;
  const next = new Map(state);
  next.delete(cardId);
  return next;
}

export function noticeCopy(kind: CardNoticeKind): "quiet 10m+" | "still running" | "state mismatch" {
  if (kind === "heartbeat-quiet") return "quiet 10m+";
  if (kind === "runaway") return "still running";
  return "state mismatch";
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/**
 * Board columns are a pure view of orchestrator truth. Waiting is deliberately
 * derived from the input flag; the UI never persists it as a phase.
 */
export function columnOf(card: Card): BoardColumn | null {
  if (card.phase === "queued") return "queue";
  if (card.phase === "working") return card.inputKind === null ? "running" : "waiting";
  if (card.phase === "review") return "review";
  if (card.phase === "done") return "done";
  return null;
}

export function interruptedMessage(count: number): string {
  return count === 1
    ? "1 card interrupted — resume from its card"
    : `${count} cards interrupted — resume from their cards`;
}

export type RailSessionEntry = {
  session: SessionMeta;
  title: string;
  agent: Exclude<Card["agent"], "none"> | null;
  previous: boolean;
  state: string;
  stateSince: number;
};

function railState(card: Card | undefined, session: SessionMeta): { state: string; since: number } {
  if (!card) return { state: session.live ? "live" : "previous", since: session.createdAt };
  if (card.phase === "working") {
    if (card.workingSub === "error") return { state: "error", since: card.updatedAt };
    if (card.inputKind) return { state: card.inputKind, since: card.inputSince ?? card.updatedAt };
    return { state: card.workingSub ?? "working", since: card.updatedAt };
  }
  if (card.phase === "review") return { state: card.reviewSub === "ready" ? "review" : card.reviewSub ?? "review", since: card.updatedAt };
  return { state: card.phase, since: card.updatedAt };
}

function railAttentionRank(card: Card | undefined): number {
  if (!card) return 4;
  if (card.workingSub === "error" || card.errorKind !== null) return 0;
  if (card.inputKind !== null) return 1;
  if (card.phase === "working") return 2;
  if (card.phase === "review") return 3;
  return 4;
}

/**
 * The rail is a projection of durable session metadata, never terminal
 * output. Agent cards are attention-first and grouped by card, with the live
 * row before its one replayable dead ring. Existing live shells stay last.
 */
export function railSessionEntries(sessions: SessionMeta[], cards: Card[]): RailSessionEntry[] {
  const cardByAttempt = new Map<number, Card>();
  for (const card of cards) {
    if (card.attemptId !== null) cardByAttempt.set(card.attemptId, card);
  }

  // T4's boot GC retains the newest dead agent ring for every current
  // attempt. Older session rows remain useful history, but are not panes.
  const latestDead = new Map<number, { session: SessionMeta; index: number }>();
  sessions.forEach((session, index) => {
    const attemptId = session.attemptId;
    if (session.kind !== "agent" || session.live || attemptId == null || !cardByAttempt.has(attemptId)) return;
    const prior = latestDead.get(attemptId);
    if (!prior || session.createdAt > prior.session.createdAt || (session.createdAt === prior.session.createdAt && index > prior.index)) {
      latestDead.set(attemptId, { session, index });
    }
  });
  const replayable = new Set([...latestDead.values()].map(value => value.session.id));

  const entries = sessions.map((session, index) => {
    const card = session.attemptId == null ? undefined : cardByAttempt.get(session.attemptId);
    const agent = card?.agent === "claude" || card?.agent === "codex" ? card.agent : null;
    const projected = railState(card, session);
    return {
      session,
      title: card?.title ?? session.title,
      agent,
      previous: !session.live,
      state: projected.state,
      stateSince: projected.since,
      attention: railAttentionRank(card),
      cardPosition: card?.position ?? Number.MAX_SAFE_INTEGER,
      cardId: card?.id ?? Number.MAX_SAFE_INTEGER,
      index,
    };
  });
  const agents = entries
    .filter(entry => entry.session.kind === "agent" && (entry.session.live || replayable.has(entry.session.id)))
    .sort((a, b) =>
      a.attention - b.attention
      || a.cardPosition - b.cardPosition
      || a.cardId - b.cardId
      || Number(b.session.live) - Number(a.session.live)
      || a.index - b.index
    );
  // Shell behavior is unchanged: only live rows, in API order.
  const shells = entries.filter(entry => entry.session.kind === "shell" && entry.session.live);
  return [...agents, ...shells].map(({
    attention: _attention,
    cardPosition: _cardPosition,
    cardId: _cardId,
    index: _index,
    ...entry
  }) => entry);
}

/** Waiting is a derived running state; stopped cards retain their attempt pane. */
export function cardRoutesToTerminal(card: Pick<Card, "phase" | "workingSub">): boolean {
  return card.phase === "working"
    && (card.workingSub === "running" || card.workingSub === "stopped" || card.workingSub === "error");
}

/** Resolve the current-attempt pane, preferring a live CLI over frozen replay. */
export function terminalSessionForCard(
  card: Pick<Card, "attemptId">,
  sessions: SessionMeta[],
): SessionMeta | null {
  if (card.attemptId === null) return null;
  let selected: SessionMeta | null = null;
  for (const session of sessions) {
    if (session.kind !== "agent" || session.attemptId !== card.attemptId) continue;
    if (
      selected === null
      || (session.live && !selected.live)
      || (session.live === selected.live && session.createdAt >= selected.createdAt)
    ) selected = session;
  }
  return selected;
}
