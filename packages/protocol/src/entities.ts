import { z } from "zod";

export const CardPhase = z.enum(["queued", "working", "review", "done", "cancelled"]);
export type CardPhase = z.infer<typeof CardPhase>;
export const WorkingSub = z.enum(["starting", "running", "stopped", "error"]);
export const ErrorKind = z.enum(["start_failed", "crashed", "interrupted"]);
export const ReviewSub = z.enum(["ready", "stale", "conflict", "updating", "merging"]);
export const PrState = z.enum(["open", "merged", "closed"]);
export type PrState = z.infer<typeof PrState>;
export const CiStatus = z.enum(["pending", "pass", "fail"]);
export type CiStatus = z.infer<typeof CiStatus>;
export const InputKind = z.enum(["question", "permission", "silent"]);
export type InputKind = z.infer<typeof InputKind>;
export const MarkState = z.enum(["running", "needs-input"]);
export type MarkState = z.infer<typeof MarkState>;
export const MarkStateBodySchema = z.object({ state: MarkState }).strict();
export const CardAgent = z.enum([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "aider",
  "amp",
  "goose",
  "generic",
  "none",
]);
export type CardAgent = z.infer<typeof CardAgent>;

export const ProjectSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), path: z.string().min(1),
  baseBranch: z.string().min(1), createdAt: z.number(),
  // Orchestrator R1 slot count (spec §5, default 1). `.default` keeps old
  // payloads (pre-v0.2 envelopes/tests) parseable while the daemon always emits it.
  workerLimit: z.int().min(1).default(1),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CardSchema = z.object({
  id: z.int(), projectId: z.string(), title: z.string().min(1),
  body: z.string(), phase: CardPhase, agent: CardAgent,
  worktreeId: z.string().nullable(), position: z.number(),
  createdAt: z.number(), updatedAt: z.number(),
  workingSub: WorkingSub.nullable(), errorKind: ErrorKind.nullable(),
  reviewSub: ReviewSub.nullable(),
  inputKind: InputKind.nullable(), inputSince: z.number().nullable(),
  round: z.int().min(1), auto: z.boolean(), attemptId: z.int().nullable(),
  readySince: z.number().nullable(),
  /** Local merge fact: the commit the merge produced (null for external/empty
   * merges). The done-card diff renders from THIS, because the VK branch-ref
   * reset deliberately zeroes base...branch right after merging. */
  mergeSha: z.string().nullable(),
  prNumber: z.int().nullable(), prUrl: z.string().nullable(),
  prState: PrState.nullable(), ciStatus: CiStatus.nullable(),
});
export type Card = z.infer<typeof CardSchema>;

export const AttemptSchema = z.object({
  id: z.int(), cardId: z.int(), worktreeId: z.string().nullable(),
  seq: z.int().min(1), status: z.enum(["running", "succeeded", "failed", "discarded"]),
  beforeHead: z.string().nullable(), createdAt: z.number(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const DispatchSchema = z.object({
  id: z.string(), attemptId: z.int(),
  status: z.enum(["running", "done", "failed", "interrupted"]),
  lastProgressAt: z.number().nullable(), createdAt: z.number(),
});
export type Dispatch = z.infer<typeof DispatchSchema>;

export const SessionMetaSchema = z.object({
  id: z.string(), projectId: z.string(), kind: z.enum(["shell", "agent"]),
  title: z.string(), cwd: z.string(), worktreeId: z.string().nullable(),
  live: z.boolean(), createdAt: z.number(),
  adapterSessionId: z.string().nullable().optional(), attemptId: z.int().nullable().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const WorktreeSync = z.enum(["clean", "behind", "conflicted", "updating", "untracked"]);
export type WorktreeSync = z.infer<typeof WorktreeSync>;

export const WorktreeSchema = z.object({
  id: z.string(), projectId: z.string(), branch: z.string(), path: z.string(),
  base: z.string(), state: z.enum(["active", "archived"]),
  sync: WorktreeSync.default("clean"), behindCount: z.int().min(0).default(0),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const DiffFileStatus = z.enum(["M", "A", "D", "R"]);
export type DiffFileStatus = z.infer<typeof DiffFileStatus>;
export type DiffHunk = {
  header: string;
  lines: Array<{ t: "ctx" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null }>;
};
export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  hunks: DiffHunk[];
};
export type DiffPayload = {
  branch: string;
  base: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
};
export type DiffSummary = { files: number; additions: number; deletions: number };
