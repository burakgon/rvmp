import type { DomainEvent } from "@codegent/protocol";

type Cb = (e: DomainEvent) => void;

const cbs = new Set<Cb>();

/** Process-wide domain event bus: store writers emit, ws/http layers fan out. */
export const events = {
  on(cb: Cb): () => void {
    cbs.add(cb);
    return () => {
      cbs.delete(cb);
    };
  },
  emit(e: DomainEvent): void {
    for (const cb of cbs) cb(e);
  },
};
