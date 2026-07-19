import type { Database } from "bun:sqlite";
import type { SessionMeta } from "@codegent/protocol";
import { PtySession } from "./session";
import { insertSession, setSessionLive, listSessions } from "../store/sessions";
import { events } from "../events";
import { mkdirSync } from "node:fs";

export interface OpenSessionOpts {
  projectId: string;
  cwd: string;
  title: string;
  worktreeId?: string | null;
}

/**
 * Registry of live PTY sessions. Persists a row per session, keeps ring files
 * under `<dataDir>/rings/<id>.bin`, and emits a `session` domain event on open
 * and again (live:false) when the process exits — whether via close() or on
 * its own (e.g. the user typed `exit`).
 */
export class PtyManager {
  private live = new Map<string, PtySession>();

  constructor(private db: Database, private dataDir: string) {
    mkdirSync(`${dataDir}/rings`, { recursive: true });
  }

  open(opts: OpenSessionOpts): SessionMeta {
    const id = crypto.randomUUID().slice(0, 8);
    const meta: SessionMeta = {
      id, projectId: opts.projectId, kind: "shell", title: opts.title,
      cwd: opts.cwd, worktreeId: opts.worktreeId ?? null, live: true, createdAt: Date.now(),
    };
    const s = new PtySession({ id, cwd: opts.cwd, ringPath: `${this.dataDir}/rings/${id}.bin` });
    this.live.set(id, s);
    insertSession(this.db, meta);
    events.emit({ t: "session", session: meta });
    s.exited.then(() => {
      this.live.delete(id);
      setSessionLive(this.db, id, false);
      events.emit({ t: "session", session: { ...meta, live: false } });
    });
    return meta;
  }

  get(id: string): PtySession | undefined {
    return this.live.get(id);
  }

  /** All live PTY sessions across projects — used by the entrypoint for graceful shutdown. */
  liveSessions(): PtySession[] {
    return [...this.live.values()];
  }

  list(projectId: string): SessionMeta[] {
    return listSessions(this.db, projectId);
  }

  close(id: string): void {
    this.live.get(id)?.kill();
  }
}
