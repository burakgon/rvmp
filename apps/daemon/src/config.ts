import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT_BASE = 4666;
const PORT_MAX = 4766; // exclusive

/**
 * Daemon config: data dir (`~/.codegent`, override `CODEGENT_DATA_DIR`),
 * a persisted 32-hex auth token at `<dataDir>/token`, and the first free
 * port from 4666 upward. The probe binds with `Bun.listen` (throws
 * EADDRINUSE synchronously when busy) and releases via `stop()` right
 * before `Bun.serve` rebinds it — verified against Bun 1.3.14.
 *
 * Data dir layout: `token` (UI-plane auth) · `db.sqlite` · `rings/` (PTY
 * scrollback) · `agents/` 0700 (signal plane: `endpoint.env` 0600 + `hook.sh`,
 * written by the hook receiver; T7 adds per-dispatch config dirs).
 */
export function loadConfig(): { port: number; dataDir: string; token: string } {
  const dataDir = process.env.CODEGENT_DATA_DIR ?? join(homedir(), ".codegent");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "agents"), { recursive: true, mode: 0o700 });
  const tokenPath = join(dataDir, "token");
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, crypto.randomUUID().replace(/-/g, ""));
  const token = readFileSync(tokenPath, "utf8").trim();
  let port = PORT_BASE;
  for (;;) {
    if (port >= PORT_MAX) throw new Error(`no free port in ${PORT_BASE}-${PORT_MAX - 1}`);
    try {
      const l = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      l.stop();
      break;
    } catch {
      port++; // busy, try next
    }
  }
  // NOTE: the discovery port file is written by the DAEMON once Bun.serve
  // actually binds (daemon.ts) — writing it here would advertise a port
  // nothing serves yet and invite a double-boot race (verify [high]).
  return { port, dataDir, token };
}
