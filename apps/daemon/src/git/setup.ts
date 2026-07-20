import { cpSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Project, Worktree } from "@codegent/protocol";

// §8 worktree bootstrap (Part 4): a fresh worktree without .env/node_modules
// is unusable — before the agent spawns, [1] copy-globs bring untracked
// config files over from the main checkout, [2] the per-project setup script
// runs inside the worktree. Script output goes to a daemon log file, never a
// card surface (principle 1); failures throw and land as start_failed.

const SETUP_TIMEOUT_MS = 120_000;

export class WorktreeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeSetupError";
  }
}

/** Copy files matching the project's copy-globs from the main checkout into
 * the worktree (paths preserved, parents created). `.git`/`.codegent` never
 * cross. Returns the copied relative paths (tests + log). */
export function copyGlobsInto(project: Pick<Project, "path" | "copyGlobs">, wtPath: string): string[] {
  const copied: string[] = [];
  const rootReal = resolve(project.path);
  const wtReal = resolve(wtPath);
  for (const pattern of project.copyGlobs) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: project.path, dot: true, onlyFiles: true })) {
      if (rel.startsWith(".git/") || rel.startsWith(".codegent/") || rel === ".git") continue;
      const src = resolve(project.path, rel);
      const dst = resolve(wtPath, rel);
      // Containment (review A-Imp): a `../…` glob match or an escaping
      // destination never crosses either boundary; symlinks are skipped —
      // a copied link could resolve outside the project.
      if (!src.startsWith(rootReal + sep)) continue;
      if (!dst.startsWith(wtReal + sep)) continue;
      try {
        if (lstatSync(src).isSymbolicLink()) continue;
      } catch { continue; }
      mkdirSync(dirname(dst), { recursive: true });
      // An INTERMEDIATE symlink inside the worktree (config -> /outside)
      // would let a lexically-contained dst escape via its parent — verify
      // the REAL parent landed inside the worktree (verify NOT-CLOSED item).
      try {
        const parentReal = realpathSync(dirname(dst));
        const wtRealResolved = realpathSync(wtReal);
        if (parentReal !== wtRealResolved && !parentReal.startsWith(wtRealResolved + sep)) continue;
      } catch { continue; }
      cpSync(src, dst);
      copied.push(rel);
    }
  }
  return copied;
}

/** Run the project's setup script in the worktree via the user's shell.
 * Output → `<logDir>/setup-<wtId>.log`; non-zero exit or timeout throws. */
export async function runSetupScript(
  project: Pick<Project, "setupScript">,
  wt: Pick<Worktree, "id" | "path">,
  logDir: string,
): Promise<void> {
  const script = project.setupScript.trim();
  if (!script) return;
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `setup-${wt.id}.log`);
  const log = Bun.file(logPath);
  const shell = process.env.SHELL || "/bin/sh";
  const proc = Bun.spawn({
    cmd: [shell, "-lc", script],
    cwd: wt.path,
    env: { ...process.env, CODEGENT_WORKTREE: wt.path },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Hard bound (review A-Imp): SIGKILL (a HUP-immune child must not outlive
  // the budget) and the WAIT ITSELF is raced — a grandchild holding the pipe
  // open can no longer wedge this promise forever.
  const timer = setTimeout(() => proc.kill(9), SETUP_TIMEOUT_MS);
  const result = await Promise.race([
    Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
    new Promise<null>((r) => setTimeout(() => r(null), SETUP_TIMEOUT_MS + 5_000)),
  ]);
  clearTimeout(timer);
  if (result === null) {
    await Bun.write(log, `$ ${script}\n--- timed out after ${SETUP_TIMEOUT_MS / 1000}s (pipes held open) ---\n`);
    throw new WorktreeSetupError(`worktree setup script timed out — see ${logPath}`);
  }
  const [code, out, err] = result;
  await Bun.write(log, `$ ${script}\n--- stdout ---\n${out}\n--- stderr ---\n${err}\n--- exit ${code} ---\n`);
  if (code !== 0) {
    throw new WorktreeSetupError(`worktree setup script failed (exit ${code}) — see ${logPath}`);
  }
}

/** The full bootstrap, in order. `logDir` defaults keep tests self-contained. */
export async function bootstrapWorktree(
  project: Pick<Project, "path" | "copyGlobs" | "setupScript">,
  wt: Pick<Worktree, "id" | "path">,
  logDir = join(tmpdir(), "codegent-setup-logs"),
): Promise<{ copied: string[] }> {
  const copied = copyGlobsInto(project, wt.path);
  await runSetupScript(project, wt, logDir);
  return { copied };
}
