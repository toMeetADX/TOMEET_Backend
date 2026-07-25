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

export const messageSourceChannelSchema = z.enum(["web", "wechat", "system", "legacy"]);
export type MessageSourceChannel = z.infer<typeof messageSourceChannelSchema>;

export const messageSchema = z.object({
  id: idSchema,
  userId: idSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20_000),
  sourceChannel: messageSourceChannelSchema.optional(),
  replyToMessageId: idSchema.nullable().optional(),
  createdAt: z.string().datetime()
});
export type Message = z.infer<typeof messageSchema>;

export const agentProductEventKindSchema = z.enum([
  "legacy_match_ready",
  "match_options",
  "match_unavailable",
  "match_confirmation_incomplete",
  "room_intro",
  "match_expired",
  "room_change",
  "draft_change",
  "unsupported_channel_message"
]);
export type AgentProductEventKind = z.infer<typeof agentProductEventKindSchema>;

export const agentProductEventSchema = z.object({
  kind: agentProductEventKindSchema,
  facts: z.record(z.unknown())
});
export type AgentProductEvent = z.infer<typeof agentProductEventSchema>;

export const agentProductMessageSchema = z.object({
  content: z.string().min(1).max(12_000),
  optionPreviews: z.array(z.object({
    optionNumber: z.number().int().min(1).max(3),
    text: z.string().min(1).max(3_000)
  })).max(3)
});
export type AgentProductMessage = z.infer<typeof agentProductMessageSchema>;

export const adventurexOnboardingStageSchema = z.enum([
  "new",
  "awaiting_image_or_text",
  "exploring",
  "ready",
  "matching"
]);
export type AdventurexOnboardingStage = z.infer<typeof adventurexOnboardingStageSchema>;

export const adventurexLanguageSchema = z.enum(["zh", "en"]);
export type AdventurexLanguage = z.infer<typeof adventurexLanguageSchema>;

export const adventurexWelcomeBubbles: Record<AdventurexLanguage, readonly string[]> = {
  zh: [
    "你好呀👋",
    "很高兴认识你",
    "你可以告诉我任何你觉得可以代表你或与你有关的东西，例如朋友圈，小红书等社交媒体帖子的截图，或者最近一段时间记录的有趣的照片",
    "这样我可以在了解你后帮助你连接AdventureX现场有趣的人和活动"
  ],
  en: [
    "Hi there 👋",
    "Nice to meet you",
    "You can share anything that feels representative of you or connected to you, such as screenshots of posts from WeChat Moments, Xiaohongshu, or other social media, or interesting photos you've taken recently",
    "Once I get to know you, I can help connect you with interesting people and activities at AdventureX"
  ]
};

export function adventurexWelcomeContent(language: AdventurexLanguage): string {
  return adventurexWelcomeBubbles[language].join("\n\n");
}

export const adventurexOnboardingStateSchema = z.object({
  userId: idSchema,
  stage: adventurexOnboardingStageSchema,
  imageDeclined: z.boolean(),
  preferredLanguage: adventurexLanguageSchema.default("zh"),
  boundaryPromptedAt: z.string().datetime().nullable().default(null),
  welcomeSentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime()
});
export type AdventurexOnboardingState = z.infer<typeof adventurexOnboardingStateSchema>;

export const socialHookDraftSchema = z.object({
  hookText: z.string().trim().min(1).max(240),
  evidenceMessageIds: z.array(idSchema).min(1).max(8)
});
export type SocialHookDraft = z.infer<typeof socialHookDraftSchema>;

export const socialHookSchema = z.object({
  id: idSchema,
  userId: idSchema,
  hookText: z.string().min(1).max(240),
  sourceMessageIds: z.array(idSchema).min(1).max(8),
  status: z.enum(["active", "forgotten"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type SocialHook = z.infer<typeof socialHookSchema>;

export const adventurexImageUnderstandingSchema = z.object({
  observableDetails: z.array(z.string().min(1).max(240)).max(5),
  uncertainty: z.array(z.string().min(1).max(240)).max(3),
  suggestedQuestion: z.string().min(1).max(500),
  reply: z.string().min(1).max(2_000)
});
export type AdventurexImageUnderstanding = z.infer<typeof adventurexImageUnderstandingSchema>;

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

export const matchRequestPhaseSchema = z.enum([
  "waiting",
  "offered",
  "selected",
  "settling",
  "push_consent",
  "watching"
]);
export type MatchRequestPhase = z.infer<typeof matchRequestPhaseSchema>;

export const matchRequestSchema = z.object({
  requestId: idSchema,
  userId: idSchema,
  intentSnapshot: z.record(z.unknown()),
  status: z.enum(["matching", "invited", "matched", "cancelled", "expired"]),
  phase: matchRequestPhaseSchema.default("waiting"),
  proactivePushEnabled: z.boolean().default(false),
  activeRoundId: idSchema.nullable().default(null),
  optionsExpiresAt: z.string().datetime().nullable().default(null),
  roomId: idSchema.nullable(),
  inviteId: idSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MatchRequest = z.infer<typeof matchRequestSchema>;

export const adventurexTestPoolStatusSchema = z.object({
  ownerUserId: idSchema,
  enabled: z.boolean(),
  desiredUserCount: z.number().int().min(3).max(12),
  provisionedUserCount: z.number().int().nonnegative(),
  availableRequestCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});
export type AdventurexTestPoolStatus = z.infer<typeof adventurexTestPoolStatusSchema>;

export const matchRoundSchema = z.object({
  roundId: idSchema,
  bucketKey: z.string().min(1).max(200),
  status: z.enum(["scheduled", "generating", "collecting", "settling", "completed", "expired"]),
  offerExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MatchRound = z.infer<typeof matchRoundSchema>;

export const matchDraftSchema = z.object({
  draftId: idSchema,
  roundId: idSchema,
  offlineGameId: idSchema,
  status: z.enum(["collecting", "formed", "expired"]),
  version: z.number().int().nonnegative(),
  targetPlayers: z.number().int().min(3).max(10),
  candidateRequestIds: z.array(idSchema).min(3).max(12),
  rationale: z.string().min(1).max(1_000).default("现场互动候选局"),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});
export type MatchDraft = z.infer<typeof matchDraftSchema>;

export const matchOptionHookSchema = z.object({
  hookId: idSchema,
  hookText: z.string().min(1).max(240),
  sourceUserId: idSchema,
  certainty: z.enum(["confirmed", "possible"])
});
export type MatchOptionHook = z.infer<typeof matchOptionHookSchema>;

export const matchOptionOfferSchema = z.object({
  offerId: idSchema,
  requestId: idSchema,
  roundId: idSchema,
  sourceType: z.enum(["draft", "open_room"]),
  draftId: idSchema.nullable(),
  roomId: idSchema.nullable(),
  sourceVersion: z.number().int().nonnegative(),
  optionNumber: z.number().int().min(1).max(3),
  offlineGameId: idSchema,
  previewText: z.string().min(1).max(2_000),
  hooks: z.array(matchOptionHookSchema).max(6).default([]),
  status: z.enum(["offered", "accepted", "rejected", "expired"]),
  createdAt: z.string().datetime(),
  respondedAt: z.string().datetime().nullable()
}).superRefine((value, context) => {
  const validDraft = value.sourceType === "draft" && value.draftId && !value.roomId;
  const validRoom = value.sourceType === "open_room" && value.roomId && !value.draftId;
  if (!validDraft && !validRoom) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "候选来源必须且只能是 draft 或 open_room" });
  }
});
export type MatchOptionOffer = z.infer<typeof matchOptionOfferSchema>;

export const matchChoiceSchema = z.object({
  choiceId: idSchema,
  requestId: idSchema,
  roundId: idSchema,
  sourceType: z.enum(["draft", "open_room"]),
  draftId: idSchema.nullable(),
  roomId: idSchema.nullable(),
  preferenceRank: z.number().int().min(1).max(3),
  requiredHookIds: z.array(idSchema).max(3),
  rawUserText: z.string().min(1).max(2_000),
  createdAt: z.string().datetime()
}).superRefine((value, context) => {
  const validDraft = value.sourceType === "draft" && value.draftId && !value.roomId;
  const validRoom = value.sourceType === "open_room" && value.roomId && !value.draftId;
  if (!validDraft && !validRoom) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "选择来源必须且只能是 draft 或 open_room" });
  }
});
export type MatchChoice = z.infer<typeof matchChoiceSchema>;

export const matchOptionContextSchema = z.object({
  requestId: idSchema,
  roundId: idSchema,
  expiresAt: z.string().datetime(),
  options: z.array(matchOptionOfferSchema.and(z.object({
    activityName: z.string().min(1),
    activityDescription: z.string().min(1)
  }))).min(1).max(3)
});
export type MatchOptionContext = z.infer<typeof matchOptionContextSchema>;

export const matchRoundProposalSchema = z.object({
  drafts: z.array(z.object({
    tempDraftId: z.string().min(1).max(64),
    offlineGameId: idSchema,
    targetPlayers: z.number().int().min(3).max(10),
    candidateRequestIds: z.array(idSchema).min(3).max(12),
    rationale: z.string().min(1).max(1_000)
  })).min(1).max(30),
  userOptions: z.array(z.object({
    requestId: idSchema,
    tempDraftIds: z.array(z.string().min(1).max(64)).min(1).max(3)
  }))
});
export type MatchRoundProposal = z.infer<typeof matchRoundProposalSchema>;

export const groupActivityJudgementSchema = z.object({
  verdict: z.enum(["bad", "acceptable", "good", "excellent"]),
  isolationRiskUserIds: z.array(idSchema).max(10),
  reasoning: z.string().min(1).max(1_000)
});
export type GroupActivityJudgement = z.infer<typeof groupActivityJudgementSchema>;

export const finalRoomDecisionSchema = z.object({
  draftId: idSchema,
  offlineGameId: idSchema,
  requestIds: z.array(idSchema).min(3).max(10),
  memberIds: z.array(idSchema).min(3).max(10),
  targetPlayers: z.number().int().min(3).max(10),
  summary: z.string().min(1).max(2_000)
});
export type FinalRoomDecision = z.infer<typeof finalRoomDecisionSchema>;

export const matchDecisionSchema = z.object({
  memberIds: z.array(idSchema).length(2),
  requestIds: z.array(idSchema).length(2),
  offlineGameId: idSchema,
  summary: z.string().min(1).max(2_000)
});
export type MatchDecision = z.infer<typeof matchDecisionSchema>;

export const roomJoinDecisionSchema = z.object({
  roomId: idSchema,
  userId: idSchema,
  requestId: idSchema,
  summary: z.string().min(1).max(2_000)
});
export type RoomJoinDecision = z.infer<typeof roomJoinDecisionSchema>;

export const matchInviteParticipantSchema = z.object({
  userId: idSchema,
  requestId: idSchema,
  displayName: z.string(),
  accepted: z.boolean()
});
export type MatchInviteParticipant = z.infer<typeof matchInviteParticipantSchema>;

export const matchInviteSchema = z.object({
  inviteId: idSchema,
  kind: z.enum(["initial_pair", "room_join"]),
  roomId: idSchema.nullable(),
  participants: z.array(matchInviteParticipantSchema).min(1).max(2),
  offlineGameId: idSchema,
  matchSummary: z.string(),
  status: z.enum(["pending", "accepted", "declined", "cancelled"]),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable()
});
export type MatchInvite = z.infer<typeof matchInviteSchema>;

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
  confirmed: z.boolean(),
  participationStatus: z.enum(["invited", "confirmed", "withdrawn"]).default("confirmed")
});
export type RoomMember = z.infer<typeof roomMemberSchema>;

export const matchRoomSchema = z.object({
  roomId: idSchema,
  members: z.array(roomMemberSchema).min(2).max(10),
  offlineGame: offlineGameSchema,
  matchSummary: z.string(),
  status: z.enum(["confirming", "confirmed", "completed"]),
  sourceDraftId: idSchema.nullable().default(null),
  targetPlayers: z.number().int().min(3).max(10).nullable().default(null),
  recruitmentStatus: z.enum(["open", "full", "closed"]).default("closed"),
  version: z.number().int().nonnegative().default(0),
  meetingPoint: z.string().max(500).nullable().default(null),
  matchingStatus: z.enum(["active", "stopped", "full"]),
  capacity: z.number().int().min(2).max(10),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable()
});
export type MatchRoom = z.infer<typeof matchRoomSchema>;

export const matchInviteResolutionSchema = z.object({
  invite: matchInviteSchema,
  room: matchRoomSchema.nullable(),
  requeuedRequestIds: z.array(idSchema)
});
export type MatchInviteResolution = z.infer<typeof matchInviteResolutionSchema>;

export const postEventFeedbackSchema = z.object({
  userId: idSchema,
  roomId: idSchema,
  peopleFeedback: z.string().min(1).max(5_000),
  gameFeedback: z.string().min(1).max(5_000),
  connectionUserIds: z.array(idSchema).max(9),
  nextIntent: z.string().min(1).max(2_000)
});
export type PostEventFeedback = z.infer<typeof postEventFeedbackSchema>;

export const userMemoryKindSchema = z.enum([
  "stable_fact",
  "preference",
  "interaction_preference",
  "social_learning",
  "boundary",
  "temporary_state",
  "multimodal_impression"
]);
export type UserMemoryKind = z.infer<typeof userMemoryKindSchema>;

export const userMemoryStatusSchema = z.enum([
  "active",
  "superseded",
  "forgotten",
  "expired"
]);
export type UserMemoryStatus = z.infer<typeof userMemoryStatusSchema>;

export const userMemorySourceTypeSchema = z.enum([
  "message",
  "multimodal",
  "feedback"
]);
export type UserMemorySourceType = z.infer<typeof userMemorySourceTypeSchema>;

export const userMemoryExplicitnessSchema = z.enum([
  "explicit",
  "experienced",
  "observed"
]);
export type UserMemoryExplicitness = z.infer<typeof userMemoryExplicitnessSchema>;

export const userMemorySchema = z.object({
  id: idSchema,
  userId: idSchema,
  kind: userMemoryKindSchema,
  stableKey: z.string().min(1).max(200),
  content: z.string().min(1).max(1_000),
  sourceType: userMemorySourceTypeSchema,
  sourceId: idSchema,
  explicitness: userMemoryExplicitnessSchema,
  status: userMemoryStatusSchema,
  supersededBy: idSchema.nullable(),
  confirmationCount: z.number().int().positive(),
  usageCount: z.number().int().nonnegative(),
  lastConfirmedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type UserMemory = z.infer<typeof userMemorySchema>;

export const userMemoryCandidateSchema = z.object({
  kind: userMemoryKindSchema,
  stableKey: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(1_000),
  expiresAt: z.string().datetime().nullable().optional()
});
export type UserMemoryCandidate = z.infer<typeof userMemoryCandidateSchema>;

export const memoryExtractionResultSchema = z.object({
  candidates: z.array(userMemoryCandidateSchema).max(8),
  forgetMemoryIds: z.array(idSchema).max(32),
  forgetAll: z.boolean(),
  rejectedSensitiveCount: z.number().int().nonnegative().max(100)
});
export type MemoryExtractionResult = z.infer<typeof memoryExtractionResultSchema>;

export const userMemoryProfileSchema = z.object({
  userId: idSchema,
  profileNarrative: z.string().max(6_000),
  matchingNarrative: z.string().max(4_000),
  sourceMemoryIds: z.array(idSchema).max(128),
  sourceWatermark: z.string().datetime().nullable(),
  version: z.number().int().nonnegative(),
  stale: z.boolean(),
  updatedAt: z.string().datetime()
});
export type UserMemoryProfile = z.infer<typeof userMemoryProfileSchema>;

export const memoryProfileDraftSchema = z.object({
  profileNarrative: z.string().max(6_000),
  matchingNarrative: z.string().max(4_000),
  sourceMemoryIds: z.array(idSchema).max(128)
});
export type MemoryProfileDraft = z.infer<typeof memoryProfileDraftSchema>;

export const llmJobTypeSchema = z.enum([
  "agent_reply",
  "agent_event_reply",
  "multimodal_understanding",
  "matchmaking",
  "match_round_generate",
  "match_round_settle",
  "room_change_notify",
  "feedback_update",
  "memory_extract",
  "memory_consolidate"
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
  partitionKey: z.string().max(200).nullable().default(null),
  runAt: z.string().datetime().default("1970-01-01T00:00:00.000Z"),
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

export const channelProviderSchema = z.enum(["wechat"]);
export type ChannelProvider = z.infer<typeof channelProviderSchema>;

export const channelIdentitySchema = z.object({
  provider: channelProviderSchema,
  externalUserId: z.string().trim().min(1).max(255),
  userId: uuidSchema,
  displayName: z.string().trim().min(1).max(80).nullable(),
  linkedAt: z.string().datetime()
});
export type ChannelIdentity = z.infer<typeof channelIdentitySchema>;

export const resolveChannelIdentityInputSchema = z.object({
  provider: channelProviderSchema,
  externalUserId: z.string().trim().min(1).max(255)
});
export type ResolveChannelIdentityInput = z.infer<typeof resolveChannelIdentityInputSchema>;

export const linkChannelIdentityInputSchema = resolveChannelIdentityInputSchema.extend({
  userId: uuidSchema,
  displayName: z.string().trim().min(1).max(80).optional()
});
export type LinkChannelIdentityInput = z.infer<typeof linkChannelIdentityInputSchema>;

export const createMatchRequestInputSchema = z.object({
  userId: uuidSchema,
  intent: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().min(8).max(128).optional()
});

export const saveMatchChoicesInputSchema = z.object({
  preferredOptionNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  acceptedOptionNumbers: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).min(1).max(3),
  requiredHookIds: z.array(idSchema).max(3).default([]),
  rawText: z.string().min(1).max(2_000).default("结构化选择")
});
export type SaveMatchChoicesInput = z.infer<typeof saveMatchChoicesInputSchema>;

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
