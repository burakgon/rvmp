import { z } from "zod";
import { CardSchema, SessionMetaSchema, AttemptSchema, ProjectSchema } from "./entities";

export const DomainEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("card"), card: CardSchema }).strict(),
  z.object({ t: z.literal("cardDeleted"), id: z.number() }).strict(),
  z.object({ t: z.literal("session"), session: SessionMetaSchema }).strict(),
  z.object({ t: z.literal("attempt"), attempt: AttemptSchema }).strict(),
  z.object({ t: z.literal("notice"), cardId: z.int(), kind: z.enum(["heartbeat-quiet", "runaway"]) }).strict(),
  z.object({ t: z.literal("project"), project: ProjectSchema }).strict(),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
