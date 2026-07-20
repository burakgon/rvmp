// §7.5 queued line comments. Deliberately a module store, NOT daemon state:
// comments are review-in-progress scratch that must survive view switches but
// may die on reload (v1 simplification, disclosed in the plan). They leave the
// browser only as the send-back batch.

export type QueuedComment = {
  id: string;
  path: string;
  /** New-side line number, or the old-side number for deleted lines. */
  line: number | null;
  text: string;
};

const store = new Map<number, QueuedComment[]>();
const subs = new Set<() => void>();
let version = 0;

const notify = () => {
  version++;
  for (const cb of subs) cb();
};

export function commentsVersion(): number {
  return version;
}

export function subscribeComments(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function commentsFor(cardId: number): QueuedComment[] {
  return store.get(cardId) ?? [];
}

export function queueComment(cardId: number, input: { path: string; line: number | null; text: string }): void {
  const text = input.text.trim();
  if (!text) return;
  const list = store.get(cardId) ?? [];
  store.set(cardId, [...list, { id: crypto.randomUUID().slice(0, 8), path: input.path, line: input.line, text }]);
  notify();
}

export function editComment(cardId: number, id: string, text: string): void {
  const list = store.get(cardId);
  if (!list) return;
  const trimmed = text.trim();
  store.set(cardId, trimmed
    ? list.map(c => (c.id === id ? { ...c, text: trimmed } : c))
    : list.filter(c => c.id !== id));
  notify();
}

export function deleteComment(cardId: number, id: string): void {
  const list = store.get(cardId);
  if (!list) return;
  store.set(cardId, list.filter(c => c.id !== id));
  notify();
}

export function clearComments(cardId: number): void {
  if (!store.has(cardId)) return;
  store.delete(cardId);
  notify();
}

/** The send-back wire format: one string per comment, file:line-prefixed so
 * the agent can locate each remark; the general note (if any) rides last. */
export function serializeComments(cardId: number, general: string): string[] {
  const out = commentsFor(cardId).map(c => `${c.path}${c.line !== null ? `:${c.line}` : ""}: ${c.text}`);
  const note = general.trim();
  if (note) out.push(note);
  return out;
}
