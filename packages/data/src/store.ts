import type {
  AdventurexLanguage,
  AdventurexTestPoolStatus,
  AdventurexOnboardingStage,
  AdventurexOnboardingState,
  ChannelIdentity,
  ChannelProvider,
  FinalRoomDecision,
  LlmJob,
  LlmJobType,
  MatchChoice,
  MatchDecision,
  MatchDraft,
  MatchOptionContext,
  MatchOptionHook,
  MatchOptionOffer,
  MatchRequest,
  MatchRound,
  MatchRoundProposal,
  MatchRoom,
  Message,
  OfflineGame,
  PostEventFeedback,
  SaveMatchChoicesInput,
  SocialHook,
  SocialHookDraft,
  UserMemory,
  UserMemoryCandidate,
  UserMemoryExplicitness,
  UserMemoryProfile,
  UserMemorySourceType,
  UserModel
} from "@tomeet/contracts";
import type { MatchCandidate } from "@tomeet/matchmaking";

export interface EnqueueJobInput {
  type: LlmJobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts?: number;
  partitionKey?: string;
  runAt?: string;
}

export interface PreparedMatchOffer {
  requestId: string;
  sourceType: "draft" | "open_room";
  tempDraftId?: string;
  roomId?: string;
  sourceVersion: number;
  optionNumber: 1 | 2 | 3;
  offlineGameId: string;
  previewText: string;
  hooks: MatchOptionHook[];
}

export interface SaveRoundPlanInput {
  roundId: string;
  proposal: MatchRoundProposal | null;
  offers: PreparedMatchOffer[];
  offerExpiresAt: string;
}

export interface RoundSettlementState {
  round: MatchRound;
  drafts: MatchDraft[];
  choices: MatchChoice[];
  requests: MatchRequest[];
  hooks: SocialHook[];
}

export interface RoomChangeNotification {
  eventId: string;
  roomId: string;
  userId: string;
  changeType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface DraftChangeNotification {
  eventId: string;
  draftId: string;
  userId: string;
  changeType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface MultimodalRecordInput {
  userId: string;
  kind: "image" | "audio";
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  hint?: string;
}

export interface LinkChannelIdentityInput {
  provider: ChannelProvider;
  externalUserId: string;
  userId: string;
  displayName?: string;
}

export interface ConversationState {
  rollingSummary: string;
  summarizedMessageCount: number;
}

export interface ApplyMemoryChangesInput {
  userId: string;
  sourceType: UserMemorySourceType;
  sourceId: string;
  explicitness: UserMemoryExplicitness;
  candidates: UserMemoryCandidate[];
  forgetMemoryIds: string[];
  forgetAll: boolean;
}

export interface ApplyMemoryChangesResult {
  memories: UserMemory[];
  forgottenCount: number;
}

export interface DataStore {
  ensureUser(userId: string, displayName?: string): Promise<void>;
  ensureAdventurexOnboardingState(userId: string): Promise<AdventurexOnboardingState>;
  startAdventurexOnboarding(userId: string, language?: AdventurexLanguage): Promise<Message | null>;
  updateAdventurexOnboardingState(
    userId: string,
    patch: {
      stage?: AdventurexOnboardingStage;
      imageDeclined?: boolean;
      preferredLanguage?: AdventurexLanguage;
      boundaryPrompted?: boolean;
    }
  ): Promise<AdventurexOnboardingState>;
  resolveChannelIdentity(
    provider: ChannelProvider,
    externalUserId: string
  ): Promise<ChannelIdentity | null>;
  linkChannelIdentity(input: LinkChannelIdentityInput): Promise<ChannelIdentity>;
  appendMessage(input: {
    userId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
    sourceChannel?: Message["sourceChannel"];
    replyToMessageId?: string | null;
  }): Promise<Message>;
  setWechatResponseGeneration(connectionId: string, generationToken: string): Promise<void>;
  isWechatResponseGenerationCurrent(connectionId: string, generationToken: string): Promise<boolean>;
  appendMessageIfWechatGenerationCurrent(input: {
    connectionId: string;
    generationToken: string;
    userId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
    sourceChannel?: Message["sourceChannel"];
    replyToMessageId?: string | null;
  }): Promise<Message | null>;
  listRecentMessages(userId: string, limit?: number): Promise<Message[]>;
  listMessagesRange(userId: string, offset: number, limit: number): Promise<Message[]>;
  countMessages(userId: string): Promise<number>;
  getConversationState(userId: string): Promise<ConversationState>;
  saveConversationSummary(
    userId: string,
    rollingSummary: string,
    summarizedMessageCount: number,
    expectedSummarizedMessageCount: number
  ): Promise<void>;
  getUserModel(userId: string): Promise<UserModel>;
  saveUserModel(model: UserModel, expectedVersion: number): Promise<UserModel>;
  listActiveMemories(userId: string, limit?: number): Promise<UserMemory[]>;
  applyMemoryChanges(input: ApplyMemoryChangesInput): Promise<ApplyMemoryChangesResult>;
  getMemoryProfile(userId: string): Promise<UserMemoryProfile>;
  saveMemoryProfile(
    profile: UserMemoryProfile,
    expectedVersion: number
  ): Promise<UserMemoryProfile>;
  markMemoryProfileStale(userId: string): Promise<void>;
  recordMemoryUsage(userId: string, memoryIds: string[]): Promise<void>;
  saveMultimodalInput(input: MultimodalRecordInput): Promise<string>;
  uploadFile(storagePath: string, mimeType: string, bytes: Uint8Array): Promise<void>;
  createSignedUpload(storagePath: string): Promise<{ path: string; token: string }>;
  resolveStorageUrl(storagePath: string): Promise<string>;
  updateMultimodalInput(inputId: string, understanding: Record<string, unknown>): Promise<void>;

  listActiveSocialHooks(userId: string, limit?: number): Promise<SocialHook[]>;
  saveSocialHooks(userId: string, hooks: SocialHookDraft[]): Promise<SocialHook[]>;
  forgetSocialHook(userId: string, hookId: string): Promise<void>;

  createMatchRequest(userId: string, intentSnapshot: Record<string, unknown>): Promise<MatchRequest>;
  getMatchRequest(requestId: string): Promise<MatchRequest | null>;
  getLatestMatchRequestForUser(userId: string): Promise<MatchRequest | null>;
  cancelMatchRequest(requestId: string): Promise<MatchRequest>;
  restartMatch(endedRequestId: string): Promise<MatchRequest>;
  setMatchRequestInterest(
    requestId: string,
    input: {
      phase: "waiting" | "push_consent" | "watching";
      proactivePushEnabled: boolean;
      clearRound?: boolean;
    }
  ): Promise<MatchRequest>;
  getAdventurexTestPoolStatus(ownerUserId: string): Promise<AdventurexTestPoolStatus>;
  configureAdventurexTestPool(
    ownerUserId: string,
    input: { enabled: boolean; desiredUserCount: number }
  ): Promise<AdventurexTestPoolStatus>;
  prepareAdventurexTestPool(ownerUserId: string): Promise<MatchRequest[]>;
  createOrGetMatchRound(bucketKey: string, scheduledAt: string): Promise<MatchRound>;
  addRequestToRound(roundId: string, requestId: string): Promise<void>;
  listRoundCandidates(roundId: string): Promise<MatchCandidate[]>;
  saveRoundProposals(input: SaveRoundPlanInput): Promise<MatchOptionOffer[]>;
  listCurrentMatchOptions(userId: string): Promise<MatchOptionContext | null>;
  saveMatchChoices(requestId: string, input: SaveMatchChoicesInput): Promise<MatchChoice[]>;
  expireMatchOptions(requestId: string): Promise<void>;
  getRoundSettlementState(roundId: string): Promise<RoundSettlementState>;
  settleMatchRound(roundId: string, decisions: FinalRoomDecision[]): Promise<string[]>;
  listSuitableOpenRooms(userId: string, limit?: number): Promise<MatchRoom[]>;
  joinOpenRoom(requestId: string, offerId: string, sourceVersion: number): Promise<MatchRoom>;
  listMatchCandidates(limit?: number): Promise<MatchCandidate[]>;
  listOfflineGames(): Promise<OfflineGame[]>;
  createRoomFromDecision(decision: MatchDecision, sourceJobId?: string): Promise<string>;
  getRoom(roomId: string): Promise<MatchRoom | null>;
  getLatestRoomForUser(userId: string): Promise<MatchRoom | null>;
  confirmRoom(roomId: string, userId: string): Promise<MatchRoom>;
  leaveRoom(roomId: string, userId: string, reason?: string): Promise<MatchRoom>;
  getRoomIntro(roomId: string, userId: string): Promise<string | null>;
  saveRoomIntro(roomId: string, userId: string, introText: string, hookIds: string[]): Promise<void>;
  listPendingRoomChangeNotifications(limit?: number): Promise<RoomChangeNotification[]>;
  markRoomChangeNotificationDelivered(eventId: string, userId: string): Promise<void>;
  listPendingDraftChangeNotifications(limit?: number): Promise<DraftChangeNotification[]>;
  markDraftChangeNotificationDelivered(eventId: string, userId: string): Promise<void>;
  completeRoom(roomId: string): Promise<MatchRoom>;
  saveFeedback(feedback: PostEventFeedback): Promise<string>;
  enqueueWechatOutboundMessage(message: Message): Promise<void>;

  enqueueJob(input: EnqueueJobInput): Promise<LlmJob>;
  getJob(jobId: string): Promise<LlmJob | null>;
  claimJob(workerId: string): Promise<LlmJob | null>;
  completeJob(jobId: string, result: Record<string, unknown>): Promise<void>;
  failJob(jobId: string, error: string): Promise<void>;
  ping(): Promise<void>;
}

export class StoreConflictError extends Error {}
export class StoreNotFoundError extends Error {}
