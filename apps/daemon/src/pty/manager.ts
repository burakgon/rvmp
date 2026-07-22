import type { Database } from "bun:sqlite";
import type { SessionMeta } from "@rvmp/protocol";
import { PtySession } from "./session";
import { getSession, insertSession, setSessionLive, listSessions, updateSessionTitle } from "../store/sessions";
import { events } from "../events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface OpenSessionOpts {
  projectId: string;
  cwd: string;
  title: string;
  worktreeId?: string | null;
  kind?: "shell" | "agent";
  /** Passed through to PtySession: agent CLI argv; default stays the interactive shell. */
  cmd?: string[];
  /** Passed through to PtySession: merged over the scrubbed base env. */
  env?: Record<string, string | undefined>;
  attemptId?: number | null;
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
      id, projectId: opts.projectId, kind: opts.kind ?? "shell", title: opts.title,
      cwd: opts.cwd, worktreeId: opts.worktreeId ?? null, live: true, createdAt: Date.now(),
      adapterSessionId: null, attemptId: opts.attemptId ?? null,
    };
    const s = new PtySession({
      id, cwd: opts.cwd, cmd: opts.cmd, env: opts.env,
      ringPath: `${this.dataDir}/rings/${id}.bin`,
    });
    this.live.set(id, s);
    try {
      insertSession(this.db, meta);
    } catch (e) {
      // Plan-1 leak fix: a failed insert must not strand a spawned PTY in the
      // live map. Kill it and forget it, then let the caller see the error.
      // (Its exit-flush may leave a row-less ring file — the boot sweep GCs it.)
      s.kill();
      this.live.delete(id);
      throw e;
    }
    events.emit({ t: "session", session: meta });
    s.exited.then(() => {
      this.live.delete(id);
      setSessionLive(this.db, id, false);
      events.emit({ t: "session", session: getSession(this.db, id) ?? { ...meta, live: false } });
    });
    return meta;
  }

  get(id: string): PtySession | undefined {
    return this.live.get(id);
  }

  /**
   * Snapshot source for a websocket subscription. Live sessions replay their
   * in-memory ring and continue streaming; retained dead sessions replay the
   * frozen ring file only. The row check plus id grammar keeps client-provided
   * session ids from becoming arbitrary filesystem paths.
   */
  replay(id: string): { snapshot: Uint8Array; session: PtySession | null } | null {
    const session = this.live.get(id);
    if (session) return { snapshot: session.snapshot(), session };
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const row = this.db.query(`SELECT live FROM sessions WHERE id = ?1`).get(id) as { live: number } | null;
    if (!row || row.live) return null;
    const path = join(this.dataDir, "rings", `${id}.bin`);
    if (!existsSync(path)) return null;
    return { snapshot: new Uint8Array(readFileSync(path)), session: null };
  }

  /** All live PTY sessions across projects — used by the entrypoint for graceful shutdown. */
  liveSessions(): PtySession[] {
    return [...this.live.values()];
  }

  list(projectId: string): SessionMeta[] {
    return listSessions(this.db, projectId);
  }

  close(id: string): boolean {
    const session = this.live.get(id);
    if (!session) return false;
    session.kill();
    return true;
  }

  rename(id: string, title: string): SessionMeta | null {
    const session = updateSessionTitle(this.db, id, title);
    if (session) events.emit({ t: "session", session });
    return session;
  }
}

/**
 * Ring GC (invoked from the entrypoint next to the `live=0` boot sweep):
 * delete `<dataDir>/rings/*.bin` whose session row is dead or missing —
 * EXCEPT the latest agent session of each card's current attempt
 * (`cards.attempt_id`), whose ring replays as the frozen "previous session"
 * scrollback (spec §4.3). Dead shell rings always go; live rows' rings are
 * never touched.
 */
export function sweepDeadRings(db: Database, dataDir: string): void {
  const dir = join(dataDir, "rings");
  if (!existsSync(dir)) return;
  const keep = new Set<string>(
    db.query(
      `SELECT id FROM sessions WHERE live = 1
       UNION
       SELECT (SELECT s.id FROM sessions s
               WHERE s.kind = 'agent' AND s.attempt_id = c.attempt_id
               ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1)
         FROM cards c WHERE c.attempt_id IS NOT NULL`,
    ).all().map((r: any) => r.id).filter((id: unknown): id is string => typeof id === "string"),
  );
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".bin") && !keep.has(f.slice(0, -".bin".length))) {
      rmSync(join(dir, f), { force: true });
    }
  }
}
