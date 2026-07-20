import { join } from "node:path";
import { loadConfig } from "./config";
import { openDb } from "./store/db";
import { PtyManager, sweepDeadRings } from "./pty/manager";
import { startServer } from "./http/server";
import { startHookReceiver, writeHookScript } from "./agents/receiver";
import { ClaudeAdapter } from "./agents/claude";
import { CodexAdapter } from "./agents/codex";
import { UniversalAdapter } from "./agents/universal";
import { Engine, bootReconcile, sweepSettingsDirs } from "./orchestrator/engine";
import { events } from "./events";

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, "db.sqlite"));

// Boot reconciliation v2 (spec §4.3, T9) — ORDER IS LOAD-BEARING:
// 1) bootReconcile: every running dispatch → failed, running attempts →
//    failed, working(starting|running) cards → error(interrupted). Running
//    this before the receiver/engine exist means a crash-surviving session's
//    late hooks and task_complete calls can only ever meet terminal
//    dispatches — they drop at the status guards instead of wedging cards
//    (the aliased round-2 swallowed-completion mode).
// 2) sweepSettingsDirs: GC per-dispatch config dirs. Safe ONLY after (1) —
//    it keeps `running` dispatch dirs, and post-reconcile the only running
//    dispatches are ones this daemon process will create.
// 3) v0.1 sweep, unchanged: session rows marked live with no process behind
//    them → live=0 (PtyManager only flips rows at runtime), then ring GC —
//    dead sessions' scrollback dies except the latest agent ring per card's
//    current attempt, which replays as the frozen "previous session" pane.
bootReconcile(db, events, Date.now());
sweepSettingsDirs(db, cfg.dataDir);
db.query(`UPDATE sessions SET live = 0`).run();
sweepDeadRings(db, cfg.dataDir);

const ptys = new PtyManager(db, cfg.dataDir);
// Signal plane: loopback hook receiver + agent API on a random port with its
// own token (endpoint file + hook script under <dataDir>/agents). The engine
// accessor is late-bound: the receiver must exist first (its port/token feed
// the adapters the engine is constructed with).
let engineRef: Engine | undefined;
const receiver = startHookReceiver({ dataDir: cfg.dataDir, db, engine: () => engineRef });
writeHookScript(cfg.dataDir);

// Orchestrator (T8): both premium adapters behind one registry, singleton
// event bus, wall clock, spec-default timers (10min heartbeat / 30min runaway
// / 30s spawn budget). Hook deliveries flow receiver → adapter normalizer →
// engine. Codex (T10) runs against a managed per-dispatch CODEX_HOME under
// <dataDir>/agents/<dispatchId> (rollouts shared across dispatches via the
// codex-home store's sessions symlink) — the user's ~/.codex is only ever read.
const claude = new ClaudeAdapter({
  dataDir: cfg.dataDir, hookPort: receiver.port, hookToken: receiver.token, ptys,
});
const codex = new CodexAdapter({
  dataDir: cfg.dataDir, hookPort: receiver.port, hookToken: receiver.token, ptys,
});
const universal = new UniversalAdapter({
  dataDir: cfg.dataDir, hookPort: receiver.port, hookToken: receiver.token, ptys,
});
const engine = new Engine({
  db,
  ptys,
  adapters: {
    claude,
    codex,
    gemini: universal,
    opencode: universal,
    aider: universal,
    amp: universal,
    goose: universal,
    generic: universal,
  },
  events,
  clock: Date.now,
});
engineRef = engine;
engine.attachHooks(receiver);

const srv = startServer(cfg, db, ptys, engine);
console.log(`codegent daemon → ${srv.url}?t=${cfg.token}`);

// R1 at boot (queued auto:on cards start when slots are free — boot
// reconciliation above already ran, so no stale rows hold slots), then the
// 30s supervision pulse (heartbeat soft-warn, runaway guard).
engine.tick();
const pulse = setInterval(() => engine.interval(), 30_000);

// Shutdown ordering: stop accepting traffic, SIGHUP every live PTY, wait
// for all of them to exit, then close the db. Each session's exit handler
// (final ring flush + `live=0` write) was registered on `exited` at open()
// — before our allSettled reaction — so per-promise FIFO guarantees those
// db writes have run by the time allSettled resolves. Only then is it safe
// to close the handle.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  // Second signal while draining: a PTY child ignoring SIGHUP must not make
  // the daemon unkillable — force quit.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  clearInterval(pulse);
  srv.stop();
  receiver.stop(); // same phase: stop accepting traffic (hook scripts fail open)
  const live = ptys.liveSessions();
  for (const s of live) s.kill();
  await Promise.allSettled(live.map(s => s.exited));
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
