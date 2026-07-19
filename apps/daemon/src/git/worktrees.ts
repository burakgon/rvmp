import type { Database } from "bun:sqlite";
import type { Project, Worktree } from "@codegent/protocol";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err);
  return out;
}

/** Ensure `.codegent/` is listed in the repo's `.git/info/exclude` — never the user's .gitignore. */
async function ensureExcluded(repoPath: string): Promise<void> {
  const gitDir = (await git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim();
  const excl = join(gitDir, "info", "exclude");
  const line = ".codegent/";
  const cur = existsSync(excl) ? readFileSync(excl, "utf8") : "";
  if (cur.split("\n").includes(line)) return;
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(excl, cur === "" || cur.endsWith("\n") ? cur + line + "\n" : cur + "\n" + line + "\n");
}

const toWt = (r: any): Worktree => ({
  id: r.id, projectId: r.project_id, branch: r.branch, path: r.path, base: r.base, state: r.state,
});

export async function createWorktree(
  db: Database, project: Project,
  opts: { cardId?: number; slugSource: string; base?: string },
): Promise<Worktree> {
  const base = opts.base ?? project.baseBranch;
  const branch = opts.cardId != null ? `cg/${opts.cardId}-${slug(opts.slugSource)}` : `wt/${slug(opts.slugSource)}`;
  const path = join(project.path, ".codegent", "worktrees", branch.replace(/\//g, "-"));
  mkdirSync(join(project.path, ".codegent", "worktrees"), { recursive: true });
  await ensureExcluded(project.path);
  await git(project.path, "worktree", "add", "-b", branch, path, base);
  const wt: Worktree = { id: crypto.randomUUID().slice(0, 8), projectId: project.id, branch, path, base, state: "active" };
  db.query(`INSERT INTO worktrees (id, project_id, branch, path, base, state) VALUES (?1,?2,?3,?4,?5,?6)`)
    .run(wt.id, wt.projectId, wt.branch, wt.path, wt.base, wt.state);
  return wt;
}

export function listWorktrees(db: Database, projectId: string): Worktree[] {
  return db.query(`SELECT * FROM worktrees WHERE project_id = ?1`).all(projectId).map(toWt);
}

export async function archiveWorktree(db: Database, project: Project, id: string): Promise<void> {
  const row = db.query(`SELECT * FROM worktrees WHERE id = ?1`).get(id) as any;
  if (!row) throw new Error(`worktree ${id} not found`);
  await git(project.path, "worktree", "remove", "--force", row.path);
  db.query(`UPDATE worktrees SET state = 'archived' WHERE id = ?1`).run(id);
}
