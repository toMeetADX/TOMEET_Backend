import { z } from "zod";

export const idSchema = z.string().min(1).max(128);
export const uuidSchema = z.string().uuid();

export const userModelSchema = z.object({
  userId: idSchema,
  vibeNarrative: z.string().max(12_000).default(""),
  longTermProfile: z.record(z.unknown()),
  currentIntent: z.record(z.unknown()),
  socialHistory: z.array(z.string()),
  feedbackMemory: z.array(z.string()),
  multimodalUnderstanding: z.record(z.unknown()),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});
export type UserModel = z.infer<typeof userModelSchema>;

export const messageSchema = z.object({
  id: idSchema,
  userId: idSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20_000),
  createdAt: z.string().datetime()
});
export type Message = z.infer<typeof messageSchema>;

export const webSearchSourceSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().url().max(2_000),
  publishedAt: z.string().max(100).optional()
});
export type WebSearchSource = z.infer<typeof webSearchSourceSchema>;

export const webSearchMetaSchema = z.object({
  status: z.enum(["not_needed", "completed", "failed", "unavailable"]),
  sources: z.array(webSearchSourceSchema).max(8)
});
export type WebSearchMeta = z.infer<typeof webSearchMetaSchema>;

export const matchRequestSchema = z.object({
  requestId: idSchema,
  userId: idSchema,
  intentSnapshot: z.record(z.unknown()),
  status: z.enum(["matching", "matched", "cancelled"]),
  roomId: idSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MatchRequest = z.infer<typeof matchRequestSchema>;

export const matchDecisionSchema = z.object({
  memberIds: z.array(idSchema).min(3).max(10),
  requestIds: z.array(idSchema).min(3).max(10),
  offlineGameId: idSchema,
  summary: z.string().min(1).max(2_000)
});
export type MatchDecision = z.infer<typeof matchDecisionSchema>;

export const offlineGameSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  minPlayers: z.number().int().min(3),
  maxPlayers: z.number().int().max(10),
  intentTags: z.array(z.string()),
  traits: z.array(z.string()),
  requirements: z.array(z.string()),
  instructions: z.array(z.string())
});
export type OfflineGame = z.infer<typeof offlineGameSchema>;

export const roomMemberSchema = z.object({
  userId: idSchema,
  displayName: z.string(),
  confirmed: z.boolean()
});
export type RoomMember = z.infer<typeof roomMemberSchema>;

export const matchRoomSchema = z.object({
  roomId: idSchema,
  members: z.array(roomMemberSchema).min(3).max(10),
  offlineGame: offlineGameSchema,
  matchSummary: z.string(),
  status: z.enum(["confirming", "confirmed", "completed"]),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable()
});
export type MatchRoom = z.infer<typeof matchRoomSchema>;

export const postEventFeedbackSchema = z.object({
  userId: idSchema,
  roomId: idSchema,
  peopleFeedback: z.string().min(1).max(5_000),
  gameFeedback: z.string().min(1).max(5_000),
  connectionUserIds: z.array(idSchema).max(9),
  nextIntent: z.string().min(1).max(2_000)
});
export type PostEventFeedback = z.infer<typeof postEventFeedbackSchema>;

export const llmJobTypeSchema = z.enum([
  "agent_reply",
  "multimodal_understanding",
  "matchmaking",
  "feedback_update"
]);
export type LlmJobType = z.infer<typeof llmJobTypeSchema>;

export const llmJobSchema = z.object({
  id: idSchema,
  type: llmJobTypeSchema,
  status: z.enum(["pending", "processing", "completed", "retry", "failed"]),
  payload: z.record(z.unknown()),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type LlmJob = z.infer<typeof llmJobSchema>;

export const agentMessageInputSchema = z.object({
  userId: uuidSchema,
  displayName: z.string().min(1).max(80),
  content: z.string().trim().min(1).max(20_000),
  idempotencyKey: z.string().min(8).max(128)
});
export type AgentMessageInput = z.infer<typeof agentMessageInputSchema>;

export const createMatchRequestInputSchema = z.object({
  userId: uuidSchema,
  intent: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().min(8).max(128).optional()
});

export const multimodalMimeTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm"
]);

export const multimodalInputSchema = z.object({
  userId: uuidSchema,
  kind: z.enum(["image", "audio"]),
  storagePath: z.string().min(1).max(2_000).refine((path) => !path.includes(".."), "存储路径无效"),
  mimeType: multimodalMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
  hint: z.string().max(2_000).optional()
}).superRefine((input, context) => {
  const expectedKind = input.mimeType.startsWith("image/") ? "image" : "audio";
  if (input.kind !== expectedKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "输入类型与 MIME 不一致" });
  }
});

export interface AgentReplyResult {
  message: Message;
  userModel: UserModel;
  socialIntentDetected: boolean;
  webSearch?: WebSearchMeta;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  requestId?: string;
  details?: unknown;
}
