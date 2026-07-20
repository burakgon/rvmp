import type { DiffFile, DiffFileStatus, DiffHunk, DiffPayload, DiffSummary } from "@codegent/protocol";

// Structured worktree diff for the review surface (spec §7.5). Everything is
// computed on demand from git — no cache (the v0.2 `compute-diffstat` effect
// stays a no-op; this module is the "diff view computes on demand" half).
//
// All functions take (repoPath, base, head) rather than a worktree path:
// `head` is usually the card's branch name, so the diff stays computable from
// the PROJECT repo even after the worktree is archived on merge (the branch
// ref survives 14 days). Three-dot semantics throughout: base...head =
// diff(merge-base(base, head), head) — the card's own changes only, never the
// base's later commits.

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err.trim() || `git ${args[0]} failed`);
  return out;
}

const DEFAULT_MAX_FILE_BYTES = 200_000;

type NumstatRow = { additions: number; deletions: number; binary: boolean };

// `--numstat -z` rows: "add\tdel\tpath\0", or for renames "add\tdel\t\0old\0new\0".
// Binary files report "-\t-". Keyed by the file's CURRENT path (old path for deletes).
function parseNumstat(raw: string): Map<string, NumstatRow> {
  const rows = new Map<string, NumstatRow>();
  const toks = raw.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok === "") continue;
    const m = tok.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const binary = m[1] === "-";
    const row: NumstatRow = {
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      binary,
    };
    let path = m[3]!;
    if (path === "") {
      // rename form: the two NUL-separated tokens that follow are old, new
      path = toks[i + 2]!; // new path
      i += 2;
    }
    rows.set(path, row);
  }
  return rows;
}

type StatusRow = { status: DiffFileStatus; path: string; oldPath: string | null };

// `--name-status -z` streams: STATUS\0path\0 (R###/C### have old\0new\0).
function parseNameStatus(raw: string): StatusRow[] {
  const out: StatusRow[] = [];
  const toks = raw.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const st = toks[i]!;
    if (st === "") continue;
    const kind = st[0]!;
    if (kind === "R" || kind === "C") {
      const oldPath = toks[i + 1]!;
      const path = toks[i + 2]!;
      i += 2;
      // Copies are additions of a new file; only renames keep the old path.
      out.push(kind === "R" ? { status: "R", path, oldPath } : { status: "A", path, oldPath: null });
    } else {
      const path = toks[i + 1]!;
      i += 1;
      const status: DiffFileStatus = kind === "A" ? "A" : kind === "D" ? "D" : "M"; // T/M/etc → M
      out.push({ status, path, oldPath: null });
    }
  }
  return out;
}

// Split one full `git diff` output into per-file chunks keyed by current path.
function splitPatch(raw: string): Map<string, string> {
  const chunks = new Map<string, string>();
  const parts = raw.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    // Prefer the +++ side; deletes have +++ /dev/null so fall back to ---.
    const plus = part.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const minus = part.match(/^--- a\/(.+)$/m)?.[1];
    const key = plus ?? minus;
    if (key) chunks.set(key, part);
  }
  return chunks;
}

function parseHunks(chunk: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of chunk.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    if (!cur) continue; // still in the file header
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      cur.lines.push({ t: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith("-")) {
      cur.lines.push({ t: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith(" ") || line === "") {
      // trailing "" from the final newline split is harmless context noise; skip it
      if (line === "") continue;
      cur.lines.push({ t: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return hunks;
}

export async function computeDiff(
  repoPath: string,
  base: string,
  head: string,
  opts?: { maxFileBytes?: number },
): Promise<DiffPayload> {
  const range = `${base}...${head}`;
  const maxBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const [statusRaw, numstatRaw, patchRaw] = await Promise.all([
    git(repoPath, "diff", "--name-status", "-z", "-M", range),
    git(repoPath, "diff", "--numstat", "-z", "-M", range),
    git(repoPath, "diff", "--no-color", "-M", range),
  ]);
  const numstat = parseNumstat(numstatRaw);
  const chunks = splitPatch(patchRaw);

  const files: DiffFile[] = parseNameStatus(statusRaw).map(row => {
    const stat = numstat.get(row.path) ?? { additions: 0, deletions: 0, binary: false };
    const chunk = chunks.get(row.path) ?? "";
    const binary = stat.binary || /^Binary files /m.test(chunk);
    const truncated = !binary && chunk.length > maxBytes;
    return {
      path: row.path,
      oldPath: row.oldPath,
      status: row.status,
      additions: stat.additions,
      deletions: stat.deletions,
      binary,
      truncated,
      hunks: binary || truncated ? [] : parseHunks(chunk),
    };
  });

  return {
    branch: head,
    base,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

export async function computeDiffSummary(repoPath: string, base: string, head: string): Promise<DiffSummary> {
  const numstat = parseNumstat(await git(repoPath, "diff", "--numstat", "-z", "-M", `${base}...${head}`));
  let additions = 0;
  let deletions = 0;
  for (const row of numstat.values()) {
    additions += row.additions;
    deletions += row.deletions;
  }
  return { files: numstat.size, additions, deletions };
}

export async function aheadBehind(
  repoPath: string,
  base: string,
  head: string,
): Promise<{ ahead: number; behind: number }> {
  const out = await git(repoPath, "rev-list", "--left-right", "--count", `${base}...${head}`);
  const m = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) throw new Error(`unexpected rev-list output: ${out.trim()}`);
  // left = commits only on base (we are BEHIND by these), right = only on head (AHEAD)
  return { behind: Number(m[1]), ahead: Number(m[2]) };
}
