import type { CiStatus, PrState } from "@codegent/protocol";

// Pull-request tracking via the `gh` CLI (spec §7.5). Merges are RECORDED
// FACTS, never git-ancestry inference (VK-proven: ancestry fails under
// squash/rebase) — the engine polls PR state and records the transition.
// Every command goes through an injectable runner so tests script gh without
// a network or a GitHub repo.

export type CommandRunner = (cwd: string, cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnRunner: CommandRunner = async (cwd, cmd) => {
  try {
    const p = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } catch {
    return { code: 127, stdout: "", stderr: "spawn failed" }; // binary absent
  }
};

export type PrInfo = { number: number; url: string; state: PrState; ci: CiStatus | null };

export type GhUnavailableReason = "no-gh" | "no-remote" | "not-authed";

/** Preflight: is PR creation even possible here? Never throws. */
export async function ghAvailable(
  run: CommandRunner,
  repoPath: string,
): Promise<{ ok: true } | { ok: false; reason: GhUnavailableReason }> {
  if ((await run(repoPath, ["gh", "--version"])).code !== 0) return { ok: false, reason: "no-gh" };
  if ((await run(repoPath, ["git", "remote", "get-url", "origin"])).code !== 0) {
    return { ok: false, reason: "no-remote" };
  }
  if ((await run(repoPath, ["gh", "auth", "status"])).code !== 0) return { ok: false, reason: "not-authed" };
  return { ok: true };
}

/** Push the head branch, open the PR, and return its live info. */
export async function createPr(
  run: CommandRunner,
  repoPath: string,
  opts: { title: string; body: string; base: string; head: string },
): Promise<PrInfo> {
  // Failure messages stay SHORT status codes — raw subprocess stderr never
  // crosses to the UI (error-mapping boundary; review B2).
  const push = await run(repoPath, ["git", "push", "-u", "origin", opts.head]);
  if (push.code !== 0) throw new Error(`branch push failed (exit ${push.code})`);
  const create = await run(repoPath, [
    "gh", "pr", "create",
    "--title", opts.title, "--body", opts.body,
    "--base", opts.base, "--head", opts.head,
  ]);
  if (create.code !== 0) throw new Error(`gh pr create failed (exit ${create.code})`);
  return viewPr(run, repoPath, opts.head);
}

/** `gh pr view --json` → PrInfo. `ref` is a PR number or a head branch name. */
export async function viewPr(run: CommandRunner, repoPath: string, ref: number | string): Promise<PrInfo> {
  const res = await run(repoPath, [
    "gh", "pr", "view", String(ref), "--json", "number,url,state,statusCheckRollup",
  ]);
  if (res.code !== 0) throw new Error(`gh pr view failed: ${res.stderr.trim() || res.code}`);
  const raw = JSON.parse(res.stdout) as {
    number: number; url: string; state: string;
    statusCheckRollup?: Array<Record<string, unknown>> | null;
  };
  const state: PrState = raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open";
  return { number: raw.number, url: raw.url, state, ci: ciFromRollup(raw.statusCheckRollup) };
}

/** Collapse gh's per-check rollup into the §7.5 read-only chip enum: any
 * failure wins, else any pending, else pass; no checks at all → null. Handles
 * both rollup item shapes (check runs use status/conclusion, status contexts
 * use state). */
export function ciFromRollup(rollup: Array<Record<string, unknown>> | null | undefined): CiStatus | null {
  if (!rollup || rollup.length === 0) return null;
  let pending = false;
  for (const item of rollup) {
    const conclusion = String(item.conclusion ?? ""); // check runs (when completed)
    const ctxState = String(item.state ?? ""); // status contexts
    const status = String(item.status ?? ""); // check runs: QUEUED/IN_PROGRESS/COMPLETED
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion)
      || ["FAILURE", "ERROR"].includes(ctxState)) return "fail";
    if ((status !== "" && status !== "COMPLETED") // unfinished check run
      || conclusion === "STALE" // a stale check re-runs — not evidence of pass
      || ctxState === "PENDING" || ctxState === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}
