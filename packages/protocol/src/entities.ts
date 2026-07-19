import { z } from "zod";

export const CardPhase = z.enum(["queued", "working", "review", "done", "cancelled"]);
export type CardPhase = z.infer<typeof CardPhase>;
export const WorkingSub = z.enum(["starting", "running", "stopped", "error"]);
export const ErrorKind = z.enum(["start_failed", "crashed", "interrupted"]);
export const ReviewSub = z.enum(["ready", "stale", "conflict", "updating", "merging"]);
export const InputKind = z.enum(["question", "permission", "silent"]);
export type InputKind = z.infer<typeof InputKind>;

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
  body: z.string(), phase: CardPhase, agent: z.enum(["claude", "codex", "none"]),
  worktreeId: z.string().nullable(), position: z.number(),
  createdAt: z.number(), updatedAt: z.number(),
  workingSub: WorkingSub.nullable(), errorKind: ErrorKind.nullable(),
  reviewSub: ReviewSub.nullable(),
  inputKind: InputKind.nullable(), inputSince: z.number().nullable(),
  round: z.int().min(1), auto: z.boolean(), attemptId: z.int().nullable(),
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

export const WorktreeSchema = z.object({
  id: z.string(), projectId: z.string(), branch: z.string(), path: z.string(),
  base: z.string(), state: z.enum(["active", "archived"]),
});
export type Worktree = z.infer<typeof WorktreeSchema>;
