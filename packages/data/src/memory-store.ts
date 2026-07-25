import { randomUUID } from "node:crypto";
import type {
  AdventurexLanguage,
  AdventurexTestPoolStatus,
  AdventurexOnboardingState,
  ChannelIdentity,
  ChannelProvider,
  FinalRoomDecision,
  LlmJob,
  MatchChoice,
  MatchDecision,
  MatchDraft,
  MatchInvite,
  MatchInviteResolution,
  MatchOptionContext,
  MatchOptionOffer,
  MatchRequest,
  MatchRound,
  MatchRoom,
  Message,
  OfflineGame,
  PostEventFeedback,
  RoomJoinDecision,
  SaveMatchChoicesInput,
  SocialHook,
  SocialHookDraft,
  UserMemory,
  UserMemoryProfile,
  UserModel
} from "@tomeet/contracts";
import { adventurexWelcomeContent } from "@tomeet/contracts";
import { curatedGames } from "@tomeet/game-catalog";
import type { MatchCandidate, RoomMatchCandidate } from "@tomeet/matchmaking";
import {
  validateFinalRoomDecision,
  validateMatchDecision,
  validateRoomJoinDecision
} from "@tomeet/matchmaking";
import { createDefaultUserModel } from "@tomeet/user-model";
import type {
  ApplyMemoryChangesInput,
  ApplyMemoryChangesResult,
  DataStore,
  DraftChangeNotification,
  EnqueueJobInput,
  LinkChannelIdentityInput,
  MultimodalRecordInput,
  RoomChangeNotification,
  RoundSettlementState,
  SaveRoundPlanInput,
  StopRoomMatchingResult
} from "./store.js";
import { StoreConflictError, StoreNotFoundError } from "./store.js";

interface MemoryUser {
  displayName: string;
  model: UserModel;
  conversation: {
    rollingSummary: string;
    summarizedMessageCount: number;
  };
}

interface MemoryMatchInvite {
  invite: MatchInvite;
  participantRequestIds: Record<string, string>;
  sourceJobId?: string;
}

export class MemoryStore implements DataStore {
  private readonly users = new Map<string, MemoryUser>();
  private readonly messages: Message[] = [];
  private readonly wechatResponseGenerations = new Map<string, string>();
  private readonly matchRequests = new Map<string, MatchRequest>();
  private readonly matchInvites = new Map<string, MemoryMatchInvite>();
  private readonly rooms = new Map<string, MatchRoom>();
  private readonly jobs = new Map<string, LlmJob>();
  private readonly jobKeys = new Map<string, string>();
  private readonly multimodal = new Map<string, MultimodalRecordInput & { understanding?: Record<string, unknown> }>();
  private readonly uploadedFiles = new Map<string, { mimeType: string; bytes: Uint8Array }>();
  private readonly feedbackKeys = new Map<string, string>();
  private readonly sourceJobInvites = new Map<string, string>();
  private readonly userMemories = new Map<string, UserMemory>();
  private readonly memoryProfiles = new Map<string, UserMemoryProfile>();
  private readonly channelIdentities = new Map<string, ChannelIdentity>();
  private readonly onboardingStates = new Map<string, AdventurexOnboardingState>();
  private readonly socialHooks = new Map<string, SocialHook>();
  private readonly rounds = new Map<string, MatchRound>();
  private readonly roundByBucket = new Map<string, string>();
  private readonly roundRequests = new Map<string, Set<string>>();
  private readonly drafts = new Map<string, MatchDraft>();
  private readonly draftTempKeys = new Map<string, string>();
  private readonly offers = new Map<string, MatchOptionOffer>();
  private readonly choices = new Map<string, MatchChoice>();
  private readonly roomIntros = new Map<string, string>();
  private readonly roomWithdrawalReasons = new Map<string, string>();
  private readonly roomNotifications = new Map<string, RoomChangeNotification>();
  private readonly deliveredRoomNotifications = new Set<string>();
  private readonly draftNotifications = new Map<string, DraftChangeNotification>();
  private readonly deliveredDraftNotifications = new Set<string>();
  private readonly demoUserIds = new Set<string>();
  private readonly testPools = new Map<string, {
    enabled: boolean;
    desiredUserCount: number;
    userIds: string[];
    updatedAt: string;
  }>();
  private readonly wechatOutboundMessages = new Map<string, Message>();

  constructor(options: { seedDemoData?: boolean } = {}) {
    if (options.seedDemoData) this.seedDemoData();
  }

  private createMemoryProfile(userId: string): UserMemoryProfile {
    return {
      userId,
      profileNarrative: "",
      matchingNarrative: "",
      sourceMemoryIds: [],
      sourceWatermark: null,
      version: 0,
      stale: false,
      updatedAt: new Date().toISOString()
    };
  }

  private createOnboardingState(userId: string): AdventurexOnboardingState {
    const now = new Date().toISOString();
    return {
      userId,
      stage: "new",
      imageDeclined: false,
      preferredLanguage: "zh",
      boundaryPromptedAt: null,
      welcomeSentAt: null,
      createdAt: now,
      updatedAt: now
    };
  }

  private seedDemoData(): void {
    const candidates = [
      ["demo-lin", "林知夏", ["摄影", "咖啡"]],
      ["demo-chen", "陈屿", ["徒步", "电影"]],
      ["demo-qiao", "乔木", ["展览", "阅读"]],
      ["demo-song", "宋然", ["桌游", "音乐"]]
    ] as const;
    for (const [userId, displayName, interests] of candidates) {
      const model = createDefaultUserModel(userId);
      model.longTermProfile = { interests: [...interests], interactionStyle: "友好自然" };
      model.currentIntent = { desiredAtmosphere: "轻松自然", rawText: "想认识新朋友" };
      this.users.set(userId, {
        displayName,
        model,
        conversation: { rollingSummary: "", summarizedMessageCount: 0 }
      });
      this.demoUserIds.add(userId);
      this.memoryProfiles.set(userId, this.createMemoryProfile(userId));
      this.onboardingStates.set(userId, this.createOnboardingState(userId));
      const now = new Date().toISOString();
      const requestId = randomUUID();
      this.matchRequests.set(requestId, {
        requestId,
        userId,
        intentSnapshot: model.currentIntent,
        status: "matching",
        phase: "waiting",
        proactivePushEnabled: false,
        activeRoundId: null,
        optionsExpiresAt: null,
        roomId: null,
        inviteId: null,
        createdAt: now,
        updatedAt: now
      });
    }
  }

  async ensureUser(userId: string, displayName = "新朋友"): Promise<void> {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        displayName,
        model: createDefaultUserModel(userId),
        conversation: { rollingSummary: "", summarizedMessageCount: 0 }
      });
      this.memoryProfiles.set(userId, this.createMemoryProfile(userId));
      this.onboardingStates.set(userId, this.createOnboardingState(userId));
    } else if (displayName !== "新朋友") {
      this.users.get(userId)!.displayName = displayName;
    }
    if (!this.memoryProfiles.has(userId)) {
      this.memoryProfiles.set(userId, this.createMemoryProfile(userId));
    }
    if (!this.onboardingStates.has(userId)) {
      this.onboardingStates.set(userId, this.createOnboardingState(userId));
    }
  }

  async ensureAdventurexOnboardingState(userId: string): Promise<AdventurexOnboardingState> {
    await this.ensureUser(userId);
    return structuredClone(this.onboardingStates.get(userId)!);
  }

  async startAdventurexOnboarding(
    userId: string,
    language: AdventurexLanguage = "zh"
  ): Promise<Message | null> {
    await this.ensureUser(userId);
    const state = this.onboardingStates.get(userId)!;
    const idempotencyKey = `adventurex-welcome:${language}:${userId}`;
    const existing = this.messages.find((message) => message.id === idempotencyKey);
    if (existing) {
      state.preferredLanguage = language;
      if (state.stage === "new") state.stage = "awaiting_image_or_text";
      state.welcomeSentAt ??= existing.createdAt;
      state.updatedAt = new Date().toISOString();
      return structuredClone(existing);
    }
    const priorConversation = this.messages.filter((message) => message.userId === userId);
    if (priorConversation.length > 0) {
      state.preferredLanguage = language;
      if (state.stage === "new" || state.stage === "awaiting_image_or_text") state.stage = "exploring";
      state.updatedAt = new Date().toISOString();
      return null;
    }
    const message = await this.appendMessage({
      userId,
      role: "assistant",
      content: adventurexWelcomeContent(language),
      idempotencyKey
    });
    const now = new Date().toISOString();
    state.stage = "awaiting_image_or_text";
    state.preferredLanguage = language;
    state.welcomeSentAt = now;
    state.updatedAt = now;
    return message;
  }

  async updateAdventurexOnboardingState(
    userId: string,
    patch: {
      stage?: AdventurexOnboardingState["stage"];
      imageDeclined?: boolean;
      preferredLanguage?: AdventurexLanguage;
      boundaryPrompted?: boolean;
    }
  ): Promise<AdventurexOnboardingState> {
    await this.ensureUser(userId);
    const state = this.onboardingStates.get(userId)!;
    if (patch.stage) state.stage = patch.stage;
    if (patch.imageDeclined !== undefined) state.imageDeclined = patch.imageDeclined;
    if (patch.preferredLanguage) state.preferredLanguage = patch.preferredLanguage;
    if (patch.boundaryPrompted && !state.boundaryPromptedAt) {
      state.boundaryPromptedAt = new Date().toISOString();
    }
    state.updatedAt = new Date().toISOString();
    return structuredClone(state);
  }

  async resolveChannelIdentity(
    provider: ChannelProvider,
    externalUserId: string
  ): Promise<ChannelIdentity | null> {
    return structuredClone(this.channelIdentities.get(`${provider}:${externalUserId}`) ?? null);
  }

  async linkChannelIdentity(input: LinkChannelIdentityInput): Promise<ChannelIdentity> {
    if (!this.users.has(input.userId)) throw new StoreNotFoundError("用户不存在");
    const key = `${input.provider}:${input.externalUserId}`;
    const existing = this.channelIdentities.get(key);
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new StoreConflictError("该渠道身份已绑定其他用户");
      }
      return structuredClone(existing);
    }
    const duplicateUser = [...this.channelIdentities.values()].find(
      (identity) => identity.provider === input.provider && identity.userId === input.userId
    );
    if (duplicateUser) throw new StoreConflictError("该用户已绑定此渠道");
    const identity: ChannelIdentity = {
      provider: input.provider,
      externalUserId: input.externalUserId,
      userId: input.userId,
      displayName: input.displayName ?? null,
      linkedAt: new Date().toISOString()
    };
    this.channelIdentities.set(key, identity);
    return structuredClone(identity);
  }

  async appendMessage(input: {
    userId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
    sourceChannel?: Message["sourceChannel"];
    replyToMessageId?: string | null;
  }): Promise<Message> {
    await this.ensureUser(input.userId);
    if (input.idempotencyKey) {
      const existing = this.messages.find((message) => message.id === input.idempotencyKey);
      if (existing) return existing;
    }
    const message: Message = {
      id: input.idempotencyKey ?? randomUUID(),
      userId: input.userId,
      role: input.role,
      content: input.content,
      sourceChannel: input.sourceChannel ?? "legacy",
      replyToMessageId: input.replyToMessageId ?? null,
      createdAt: new Date().toISOString()
    };
    this.messages.push(message);
    return message;
  }

  async setWechatResponseGeneration(connectionId: string, generationToken: string): Promise<void> {
    this.wechatResponseGenerations.set(connectionId, generationToken);
  }

  async isWechatResponseGenerationCurrent(
    connectionId: string,
    generationToken: string
  ): Promise<boolean> {
    return this.wechatResponseGenerations.get(connectionId) === generationToken;
  }

  async appendMessageIfWechatGenerationCurrent(input: {
    connectionId: string;
    generationToken: string;
    userId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
    sourceChannel?: Message["sourceChannel"];
    replyToMessageId?: string | null;
  }): Promise<Message | null> {
    if (!(await this.isWechatResponseGenerationCurrent(input.connectionId, input.generationToken))) {
      return null;
    }
    return this.appendMessage(input);
  }

  async listRecentMessages(userId: string, limit = 50): Promise<Message[]> {
    return this.messages.filter((message) => message.userId === userId).slice(-limit);
  }

  async listMessagesRange(userId: string, offset: number, limit: number): Promise<Message[]> {
    return this.messages
      .filter((message) => message.userId === userId)
      .slice(offset, offset + limit)
      .map((message) => structuredClone(message));
  }

  async countMessages(userId: string): Promise<number> {
    return this.messages.filter((message) => message.userId === userId).length;
  }

  async getConversationState(userId: string) {
    await this.ensureUser(userId);
    return structuredClone(this.users.get(userId)!.conversation);
  }

  async saveConversationSummary(
    userId: string,
    rollingSummary: string,
    summarizedMessageCount: number,
    expectedSummarizedMessageCount: number
  ): Promise<void> {
    await this.ensureUser(userId);
    const conversation = this.users.get(userId)!.conversation;
    if (conversation.summarizedMessageCount !== expectedSummarizedMessageCount) {
      throw new StoreConflictError("对话摘要已被其他任务更新");
    }
    conversation.rollingSummary = rollingSummary;
    conversation.summarizedMessageCount = summarizedMessageCount;
  }

  async getUserModel(userId: string): Promise<UserModel> {
    await this.ensureUser(userId);
    return structuredClone(this.users.get(userId)!.model);
  }

  async saveUserModel(model: UserModel, expectedVersion: number): Promise<UserModel> {
    await this.ensureUser(model.userId);
    const user = this.users.get(model.userId)!;
    if (user.model.version !== expectedVersion) throw new StoreConflictError("用户模型已被其他任务更新");
    user.model = structuredClone(model);
    return structuredClone(user.model);
  }

  async listActiveMemories(userId: string, limit = 128): Promise<UserMemory[]> {
    await this.ensureUser(userId);
    const now = Date.now();
    let expired = false;
    for (const memory of this.userMemories.values()) {
      if (
        memory.userId === userId
        && memory.status === "active"
        && memory.expiresAt
        && new Date(memory.expiresAt).getTime() <= now
      ) {
        memory.status = "expired";
        memory.updatedAt = new Date().toISOString();
        expired = true;
      }
    }
    if (expired) await this.markMemoryProfileStale(userId);
    return [...this.userMemories.values()]
      .filter((memory) => memory.userId === userId && memory.status === "active")
      .sort((left, right) => right.lastConfirmedAt.localeCompare(left.lastConfirmedAt))
      .slice(0, Math.min(Math.max(limit, 1), 128))
      .map((memory) => structuredClone(memory));
  }

  async applyMemoryChanges(input: ApplyMemoryChangesInput): Promise<ApplyMemoryChangesResult> {
    await this.ensureUser(input.userId);
    const now = new Date().toISOString();
    let forgottenCount = 0;
    if (input.forgetAll) {
      for (const memory of this.userMemories.values()) {
        if (memory.userId !== input.userId || memory.status !== "active") continue;
        memory.status = "forgotten";
        memory.updatedAt = now;
        forgottenCount += 1;
      }
    }
    for (const memoryId of new Set(input.forgetMemoryIds)) {
      const memory = this.userMemories.get(memoryId);
      if (!memory || memory.userId !== input.userId || memory.status !== "active") continue;
      memory.status = "forgotten";
      memory.updatedAt = now;
      forgottenCount += 1;
    }

    const written: UserMemory[] = [];
    for (const candidate of input.candidates) {
      const existing = [...this.userMemories.values()].find((memory) =>
        memory.userId === input.userId
        && memory.status === "active"
        && memory.kind === candidate.kind
        && memory.stableKey === candidate.stableKey
      );
      if (existing?.content === candidate.content) {
        existing.confirmationCount += 1;
        existing.lastConfirmedAt = now;
        existing.sourceType = input.sourceType;
        existing.sourceId = input.sourceId;
        existing.explicitness = input.explicitness;
        existing.expiresAt = candidate.expiresAt ?? null;
        existing.updatedAt = now;
        written.push(structuredClone(existing));
        continue;
      }

      const id = randomUUID();
      const memory: UserMemory = {
        id,
        userId: input.userId,
        kind: candidate.kind,
        stableKey: candidate.stableKey,
        content: candidate.content,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        explicitness: input.explicitness,
        status: "active",
        supersededBy: null,
        confirmationCount: 1,
        usageCount: 0,
        lastConfirmedAt: now,
        lastUsedAt: null,
        expiresAt: candidate.expiresAt ?? null,
        createdAt: now,
        updatedAt: now
      };
      if (existing) {
        existing.status = "superseded";
        existing.supersededBy = id;
        existing.updatedAt = now;
      }
      this.userMemories.set(id, memory);
      written.push(structuredClone(memory));
    }

    if (forgottenCount > 0 || written.length > 0) {
      await this.markMemoryProfileStale(input.userId);
    }
    return { memories: written, forgottenCount };
  }

  async getMemoryProfile(userId: string): Promise<UserMemoryProfile> {
    await this.ensureUser(userId);
    await this.listActiveMemories(userId, 1);
    return structuredClone(this.memoryProfiles.get(userId)!);
  }

  async saveMemoryProfile(
    profile: UserMemoryProfile,
    expectedVersion: number
  ): Promise<UserMemoryProfile> {
    await this.ensureUser(profile.userId);
    const current = this.memoryProfiles.get(profile.userId)!;
    if (current.version !== expectedVersion) {
      throw new StoreConflictError("用户记忆画像已被其他任务更新");
    }
    this.memoryProfiles.set(profile.userId, structuredClone(profile));
    return structuredClone(profile);
  }

  async markMemoryProfileStale(userId: string): Promise<void> {
    await this.ensureUser(userId);
    const profile = this.memoryProfiles.get(userId)!;
    profile.stale = true;
    profile.updatedAt = new Date().toISOString();
  }

  async recordMemoryUsage(userId: string, memoryIds: string[]): Promise<void> {
    const now = new Date().toISOString();
    for (const memoryId of new Set(memoryIds)) {
      const memory = this.userMemories.get(memoryId);
      if (!memory || memory.userId !== userId || memory.status !== "active") continue;
      memory.usageCount += 1;
      memory.lastUsedAt = now;
      memory.updatedAt = now;
    }
  }

  async saveMultimodalInput(input: MultimodalRecordInput): Promise<string> {
    await this.ensureUser(input.userId);
    if (!input.storagePath.startsWith(`${input.userId}/`) || input.storagePath.includes("..")) {
      throw new StoreConflictError("多模态文件不属于当前用户");
    }
    const id = randomUUID();
    this.multimodal.set(id, structuredClone(input));
    return id;
  }

  async createSignedUpload(storagePath: string): Promise<{ path: string; token: string }> {
    return { path: storagePath, token: "demo" };
  }

  async uploadFile(storagePath: string, mimeType: string, bytes: Uint8Array): Promise<void> {
    this.uploadedFiles.set(storagePath, { mimeType, bytes: Uint8Array.from(bytes) });
  }

  async resolveStorageUrl(storagePath: string): Promise<string> {
    const uploaded = this.uploadedFiles.get(storagePath);
    if (uploaded) {
      return `data:${uploaded.mimeType};base64,${Buffer.from(uploaded.bytes).toString("base64")}`;
    }
    return storagePath;
  }

  async updateMultimodalInput(inputId: string, understanding: Record<string, unknown>): Promise<void> {
    const input = this.multimodal.get(inputId);
    if (!input) throw new StoreNotFoundError("多模态输入不存在");
    input.understanding = structuredClone(understanding);
  }

  async listActiveSocialHooks(userId: string, limit = 32): Promise<SocialHook[]> {
    await this.ensureUser(userId);
    return [...this.socialHooks.values()]
      .filter((hook) => hook.userId === userId && hook.status === "active")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 128))
      .map((hook) => structuredClone(hook));
  }

  async saveSocialHooks(userId: string, drafts: SocialHookDraft[]): Promise<SocialHook[]> {
    await this.ensureUser(userId);
    const saved: SocialHook[] = [];
    for (const draft of drafts) {
      const sourceIds = [...new Set(draft.evidenceMessageIds)];
      if (sourceIds.length === 0 || sourceIds.some((messageId) => !this.messages.some(
        (message) => message.id === messageId && message.userId === userId && message.role === "user"
      ))) {
        throw new StoreConflictError("社交钩子只能引用当前用户的文字消息");
      }
      const existing = [...this.socialHooks.values()].find(
        (hook) => hook.userId === userId && hook.hookText === draft.hookText
      );
      const now = new Date().toISOString();
      if (existing) {
        existing.status = "active";
        existing.sourceMessageIds = [...new Set([...existing.sourceMessageIds, ...sourceIds])].slice(0, 8);
        existing.updatedAt = now;
        saved.push(structuredClone(existing));
        continue;
      }
      const hook: SocialHook = {
        id: randomUUID(),
        userId,
        hookText: draft.hookText,
        sourceMessageIds: sourceIds,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      this.socialHooks.set(hook.id, hook);
      saved.push(structuredClone(hook));
    }
    return saved;
  }

  async forgetSocialHook(userId: string, hookId: string): Promise<void> {
    const hook = this.socialHooks.get(hookId);
    if (!hook || hook.userId !== userId) throw new StoreNotFoundError("社交钩子不存在");
    hook.status = "forgotten";
    hook.updatedAt = new Date().toISOString();
  }

  async createMatchRequest(userId: string, intentSnapshot: Record<string, unknown>): Promise<MatchRequest> {
    await this.ensureUser(userId);
    const activeRoom = [...this.rooms.values()].find(
      (room) => room.status !== "completed" && room.members.some(
        (member) => member.userId === userId && member.participationStatus !== "withdrawn"
      )
    );
    if (activeRoom) throw new StoreConflictError("你还有一个未结束的匹配房间");
    const existing = [...this.matchRequests.values()].find(
      (request) => request.userId === userId
        && (request.status === "matching" || request.status === "invited")
    );
    if (existing) return structuredClone(existing);
    const now = new Date().toISOString();
    const request: MatchRequest = {
      requestId: randomUUID(),
      userId,
      intentSnapshot: structuredClone(intentSnapshot),
      status: "matching",
      phase: "waiting",
      proactivePushEnabled: false,
      activeRoundId: null,
      optionsExpiresAt: null,
      roomId: null,
      inviteId: null,
      createdAt: now,
      updatedAt: now
    };
    this.matchRequests.set(request.requestId, request);
    return structuredClone(request);
  }

  async getMatchRequest(requestId: string): Promise<MatchRequest | null> {
    const request = this.matchRequests.get(requestId);
    return request ? structuredClone(request) : null;
  }

  async getLatestMatchRequestForUser(userId: string): Promise<MatchRequest | null> {
    const request = [...this.matchRequests.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return request ? structuredClone(request) : null;
  }

  async cancelMatchRequest(requestId: string): Promise<MatchRequest> {
    const request = this.matchRequests.get(requestId);
    if (!request) throw new StoreNotFoundError("匹配请求不存在");
    if (request.status !== "matching") throw new StoreConflictError("只能取消仍在匹配中的请求");
    request.status = "cancelled";
    request.phase = "waiting";
    request.proactivePushEnabled = false;
    request.activeRoundId = null;
    request.optionsExpiresAt = null;
    request.inviteId = null;
    request.updatedAt = new Date().toISOString();
    for (const offer of this.offers.values()) {
      if (offer.requestId === requestId && offer.status === "offered") offer.status = "expired";
    }
    return structuredClone(request);
  }

  async restartMatch(endedRequestId: string): Promise<MatchRequest> {
    const previous = this.matchRequests.get(endedRequestId);
    if (!previous) throw new StoreNotFoundError("匹配请求不存在");
    if (previous.status !== "cancelled" && previous.status !== "expired") {
      throw new StoreConflictError("只能从已取消或已超时的请求重新匹配");
    }
    return this.createMatchRequest(previous.userId, structuredClone(previous.intentSnapshot));
  }

  async setMatchRequestInterest(
    requestId: string,
    input: {
      phase: "waiting" | "push_consent" | "watching";
      proactivePushEnabled: boolean;
      clearRound?: boolean;
    }
  ): Promise<MatchRequest> {
    const request = this.matchRequests.get(requestId);
    if (!request || request.status !== "matching") throw new StoreNotFoundError("匹配请求不存在或已结束");
    request.phase = input.phase;
    request.proactivePushEnabled = input.proactivePushEnabled;
    if (input.clearRound) {
      request.activeRoundId = null;
      request.optionsExpiresAt = null;
      for (const offer of this.offers.values()) {
        if (offer.requestId === requestId && offer.status === "offered") offer.status = "expired";
      }
    }
    request.updatedAt = new Date().toISOString();
    return structuredClone(request);
  }

  async getAdventurexTestPoolStatus(ownerUserId: string): Promise<AdventurexTestPoolStatus> {
    const state = this.testPools.get(ownerUserId) ?? {
      enabled: false,
      desiredUserCount: 5,
      userIds: [],
      updatedAt: new Date(0).toISOString()
    };
    const availableRequestCount = state.userIds.filter((userId) =>
      [...this.matchRequests.values()].some((request) => request.userId === userId && request.status === "matching")
    ).length;
    return {
      ownerUserId,
      enabled: state.enabled,
      desiredUserCount: state.desiredUserCount,
      provisionedUserCount: state.userIds.length,
      availableRequestCount,
      updatedAt: state.updatedAt
    };
  }

  async configureAdventurexTestPool(
    ownerUserId: string,
    input: { enabled: boolean; desiredUserCount: number }
  ): Promise<AdventurexTestPoolStatus> {
    await this.ensureUser(ownerUserId);
    const existing = this.testPools.get(ownerUserId) ?? {
      enabled: false,
      desiredUserCount: input.desiredUserCount,
      userIds: [],
      updatedAt: new Date().toISOString()
    };
    existing.enabled = input.enabled;
    existing.desiredUserCount = input.desiredUserCount;
    existing.updatedAt = new Date().toISOString();
    const fixtureFacts = [
      "独立完成过一款小游戏",
      "组织过一次十人线下活动",
      "参加过两次现场黑客松",
      "和朋友做过一场小型展览",
      "在乐队里负责过贝斯",
      "连续记录过一百天城市照片",
      "带队完成过一次户外挑战",
      "做过一套现场互动卡牌",
      "主持过多次陌生人圆桌",
      "和团队共同完成过短片"
    ];
    while (existing.userIds.length < input.desiredUserCount) {
      const index = existing.userIds.length;
      const userId = randomUUID();
      await this.ensureUser(userId, `虚拟测试用户${index + 1}`);
      this.demoUserIds.add(userId);
      const user = this.users.get(userId)!;
      user.model.vibeNarrative = `测试人物 ${index + 1}：表达节奏清楚，愿意通过具体活动逐步进入交流。`;
      user.model.currentIntent = { rawText: "愿意参加现场活动并认识新的人" };
      const source = await this.appendMessage({
        userId,
        role: "user",
        content: `我${fixtureFacts[index % fixtureFacts.length]}`,
        idempotencyKey: `test-pool-source:${ownerUserId}:${index}`
      });
      await this.saveSocialHooks(userId, [{
        hookText: fixtureFacts[index % fixtureFacts.length]!,
        evidenceMessageIds: [source.id]
      }]);
      existing.userIds.push(userId);
    }
    this.testPools.set(ownerUserId, existing);
    return this.getAdventurexTestPoolStatus(ownerUserId);
  }

  async prepareAdventurexTestPool(ownerUserId: string): Promise<MatchRequest[]> {
    const state = this.testPools.get(ownerUserId);
    if (!state?.enabled) return [];
    const requests: MatchRequest[] = [];
    for (const userId of state.userIds.slice(0, state.desiredUserCount)) {
      const active = [...this.matchRequests.values()].find(
        (request) => request.userId === userId && request.status === "matching"
      );
      const request = active ?? await this.createMatchRequest(userId, {
        rawText: "愿意参加现场活动并认识新的人",
        virtualTestUser: true,
        testPoolOwnerUserId: ownerUserId
      });
      requests.push(request);
    }
    return requests;
  }

  async createOrGetMatchRound(bucketKey: string, _scheduledAt: string): Promise<MatchRound> {
    const existingId = this.roundByBucket.get(bucketKey);
    if (existingId) return structuredClone(this.rounds.get(existingId)!);
    const now = new Date().toISOString();
    const round: MatchRound = {
      roundId: randomUUID(),
      bucketKey,
      status: "scheduled",
      offerExpiresAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.rounds.set(round.roundId, round);
    this.roundByBucket.set(bucketKey, round.roundId);
    this.roundRequests.set(round.roundId, new Set());
    return structuredClone(round);
  }

  async addRequestToRound(roundId: string, requestId: string): Promise<void> {
    const round = this.rounds.get(roundId);
    const request = this.matchRequests.get(requestId);
    if (!round) throw new StoreNotFoundError("匹配轮次不存在");
    if (!request) throw new StoreNotFoundError("匹配请求不存在");
    if (request.status !== "matching") throw new StoreConflictError("匹配请求已不活跃");
    this.roundRequests.get(roundId)!.add(requestId);
    request.activeRoundId = roundId;
    request.phase = "waiting";
    request.optionsExpiresAt = null;
    request.updatedAt = new Date().toISOString();
  }

  async listRoundCandidates(roundId: string): Promise<MatchCandidate[]> {
    const requestIds = this.roundRequests.get(roundId);
    if (!requestIds) throw new StoreNotFoundError("匹配轮次不存在");
    const round = this.rounds.get(roundId)!;
    const assigned = [...requestIds]
      .map((requestId) => this.matchRequests.get(requestId))
      .filter((request): request is MatchRequest => Boolean(
        request && request.status === "matching" && request.phase === "waiting" && request.activeRoundId === roundId
      ));
    const watching = round.bucketKey.startsWith("adventurex-test:")
      ? []
      : [...this.matchRequests.values()].filter((request) =>
          request.status === "matching"
          && request.phase === "watching"
          && request.proactivePushEnabled
          && request.intentSnapshot.virtualTestUser !== true
        );
    const prioritized = [
      ...assigned.map((request) => ({ request, matchingPriority: "active_waiting" as const })),
      ...watching.map((request) => ({
        request,
        matchingPriority: [...this.choices.values()].some((choice) => choice.requestId === request.requestId)
          ? "confirmation_follow_up" as const
          : "watching" as const
      }))
    ];
    const requests = [...new Map(prioritized.map((entry) => [entry.request.requestId, entry])).values()]
      .sort((left, right) => {
        const priorityRank = { active_waiting: 0, confirmation_follow_up: 1, watching: 2 } as const;
        return priorityRank[left.matchingPriority] - priorityRank[right.matchingPriority]
          || left.request.createdAt.localeCompare(right.request.createdAt);
      })
      .slice(0, 24);
    return Promise.all(requests.map(async ({ request, matchingPriority }) => ({
      request: structuredClone(request),
      userModel: structuredClone(this.users.get(request.userId)!.model),
      matchingNarrative: this.memoryProfiles.get(request.userId)?.matchingNarrative
        || this.users.get(request.userId)!.model.vibeNarrative,
      socialHooks: await this.listActiveSocialHooks(request.userId, 12),
      matchingPriority
    })));
  }

  async saveRoundProposals(input: SaveRoundPlanInput): Promise<MatchOptionOffer[]> {
    const round = this.rounds.get(input.roundId);
    if (!round) throw new StoreNotFoundError("匹配轮次不存在");
    if (round.status === "completed" || round.status === "expired") {
      return [...this.offers.values()].filter((offer) => offer.roundId === input.roundId).map((offer) => structuredClone(offer));
    }
    const tempDraftIds = new Map<string, string>();
    for (const proposal of input.proposal?.drafts ?? []) {
      const existingId = this.draftTempKeys.get(`${input.roundId}:${proposal.tempDraftId}`);
      const existing = existingId ? this.drafts.get(existingId) : undefined;
      const draftId = existing?.draftId ?? randomUUID();
      tempDraftIds.set(proposal.tempDraftId, draftId);
      if (!existing) {
        this.drafts.set(draftId, {
          draftId,
          roundId: input.roundId,
          offlineGameId: proposal.offlineGameId,
          status: "collecting",
          version: 0,
          targetPlayers: proposal.targetPlayers,
          candidateRequestIds: [...proposal.candidateRequestIds],
          rationale: proposal.rationale,
          createdAt: new Date().toISOString(),
          expiresAt: input.offerExpiresAt
        });
        this.draftTempKeys.set(`${input.roundId}:${proposal.tempDraftId}`, draftId);
      }
    }
    const saved: MatchOptionOffer[] = [];
    for (const prepared of input.offers) {
      const request = this.matchRequests.get(prepared.requestId);
      if (!request || request.status !== "matching" || request.activeRoundId !== input.roundId) continue;
      const existing = [...this.offers.values()].find(
        (offer) => offer.requestId === prepared.requestId
          && offer.roundId === input.roundId
          && offer.optionNumber === prepared.optionNumber
      );
      if (existing) {
        saved.push(structuredClone(existing));
        continue;
      }
      const draftId = prepared.sourceType === "draft"
        ? tempDraftIds.get(prepared.tempDraftId ?? "") ?? null
        : null;
      if (prepared.sourceType === "draft" && !draftId) throw new StoreConflictError("候选局映射不存在");
      const offer: MatchOptionOffer = {
        offerId: randomUUID(),
        requestId: prepared.requestId,
        roundId: input.roundId,
        sourceType: prepared.sourceType,
        draftId,
        roomId: prepared.sourceType === "open_room" ? prepared.roomId ?? null : null,
        sourceVersion: prepared.sourceVersion,
        optionNumber: prepared.optionNumber,
        offlineGameId: prepared.offlineGameId,
        previewText: prepared.previewText,
        hooks: structuredClone(prepared.hooks),
        status: "offered",
        createdAt: new Date().toISOString(),
        respondedAt: null
      };
      this.offers.set(offer.offerId, offer);
      request.phase = "offered";
      request.optionsExpiresAt = input.offerExpiresAt;
      request.updatedAt = new Date().toISOString();
      saved.push(structuredClone(offer));
    }
    round.status = "collecting";
    round.offerExpiresAt = input.offerExpiresAt;
    round.updatedAt = new Date().toISOString();
    return saved;
  }

  async listCurrentMatchOptions(userId: string): Promise<MatchOptionContext | null> {
    const request = [...this.matchRequests.values()]
      .filter((item) => item.userId === userId && item.status === "matching" && ["offered", "selected"].includes(item.phase))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!request?.activeRoundId || !request.optionsExpiresAt) return null;
    const options = [...this.offers.values()]
      .filter((offer) => offer.requestId === request.requestId && offer.roundId === request.activeRoundId && offer.status !== "expired")
      .sort((left, right) => left.optionNumber - right.optionNumber)
      .map((offer) => {
        const game = curatedGames.find((item) => item.id === offer.offlineGameId);
        if (!game) throw new StoreNotFoundError("活动不存在");
        return {
          ...structuredClone(offer),
          activityName: game.name,
          activityDescription: game.description
        };
      });
    return options.length > 0 ? {
      requestId: request.requestId,
      roundId: request.activeRoundId,
      expiresAt: request.optionsExpiresAt,
      options
    } : null;
  }

  async saveMatchChoices(requestId: string, input: SaveMatchChoicesInput): Promise<MatchChoice[]> {
    const request = this.matchRequests.get(requestId);
    if (!request || request.status !== "matching" || !request.activeRoundId) throw new StoreConflictError("匹配请求当前不能选择");
    if (request.optionsExpiresAt && new Date(request.optionsExpiresAt).getTime() <= Date.now()) {
      throw new StoreConflictError("候选已过期");
    }
    const acceptedNumbers = [...new Set(input.acceptedOptionNumbers)];
    const currentOffers = [...this.offers.values()].filter(
      (offer) => offer.requestId === requestId && offer.roundId === request.activeRoundId && offer.status !== "expired"
    );
    const acceptedOffers = acceptedNumbers.map((number) => currentOffers.find((offer) => offer.optionNumber === number));
    if (acceptedOffers.some((offer) => !offer)) throw new StoreConflictError("选择包含不存在的候选编号");
    const allowedRequiredHooks = new Set(acceptedOffers.flatMap((offer) => offer!.hooks.map((hook) => hook.hookId)));
    if (input.requiredHookIds.some((hookId) => !allowedRequiredHooks.has(hookId))) {
      throw new StoreConflictError("required hook 必须来自已接受候选");
    }
    for (const [choiceId, choice] of this.choices) {
      if (choice.requestId === requestId && choice.roundId === request.activeRoundId) this.choices.delete(choiceId);
    }
    const now = new Date().toISOString();
    const saved = acceptedOffers.map((offer, index): MatchChoice => {
      const requiredHookIds = input.requiredHookIds.filter((hookId) => offer!.hooks.some((hook) => hook.hookId === hookId));
      const choice: MatchChoice = {
        choiceId: randomUUID(),
        requestId,
        roundId: request.activeRoundId!,
        sourceType: offer!.sourceType,
        draftId: offer!.draftId,
        roomId: offer!.roomId,
        preferenceRank: input.preferredOptionNumber === null
          ? 1
          : offer!.optionNumber === input.preferredOptionNumber ? 1 : Math.min(3, index + 2),
        requiredHookIds,
        rawUserText: input.rawText,
        createdAt: now
      };
      this.choices.set(choice.choiceId, choice);
      return structuredClone(choice);
    });
    for (const offer of currentOffers) {
      offer.status = acceptedNumbers.includes(offer.optionNumber as 1 | 2 | 3) ? "accepted" : "rejected";
      offer.respondedAt = now;
    }
    request.phase = "selected";
    request.updatedAt = now;
    return saved;
  }

  async expireMatchOptions(requestId: string): Promise<void> {
    const request = this.matchRequests.get(requestId);
    if (!request) throw new StoreNotFoundError("匹配请求不存在");
    for (const offer of this.offers.values()) {
      if (offer.requestId === requestId && ["offered", "accepted", "rejected"].includes(offer.status)) offer.status = "expired";
    }
    for (const [choiceId, choice] of this.choices) {
      if (choice.requestId === requestId) this.choices.delete(choiceId);
    }
    if (request.status === "matching") {
      request.phase = "waiting";
      request.activeRoundId = null;
      request.optionsExpiresAt = null;
      request.updatedAt = new Date().toISOString();
    }
  }

  async getRoundSettlementState(roundId: string): Promise<RoundSettlementState> {
    const round = this.rounds.get(roundId);
    if (!round) throw new StoreNotFoundError("匹配轮次不存在");
    const requestIds = this.roundRequests.get(roundId) ?? new Set<string>();
    const requests = [...requestIds].map((requestId) => this.matchRequests.get(requestId)).filter(Boolean) as MatchRequest[];
    const hooks = requests.flatMap((request) => [...this.socialHooks.values()].filter(
      (hook) => hook.userId === request.userId && hook.status === "active"
    ));
    return {
      round: structuredClone(round),
      drafts: [...this.drafts.values()].filter((draft) => draft.roundId === roundId).map((draft) => structuredClone(draft)),
      choices: [...this.choices.values()].filter((choice) => choice.roundId === roundId).map((choice) => structuredClone(choice)),
      requests: requests.map((request) => structuredClone(request)),
      hooks: hooks.map((hook) => structuredClone(hook))
    };
  }

  async settleMatchRound(roundId: string, decisions: FinalRoomDecision[]): Promise<string[]> {
    const round = this.rounds.get(roundId);
    if (!round) throw new StoreNotFoundError("匹配轮次不存在");
    if (round.status === "completed") {
      return [...this.rooms.values()]
        .filter((room) => room.sourceDraftId && this.drafts.get(room.sourceDraftId)?.roundId === roundId)
        .map((room) => room.roomId);
    }
    round.status = "settling";
    const state = await this.getRoundSettlementState(roundId);
    const hookSources = new Map(state.hooks.map((hook) => [hook.id, hook.userId]));
    const roomIds: string[] = [];
    const usedUsers = new Set<string>();
    for (const decision of decisions) {
      const existing = [...this.rooms.values()].find((room) => room.sourceDraftId === decision.draftId);
      if (existing) {
        roomIds.push(existing.roomId);
        continue;
      }
      if (decision.memberIds.some((userId) => usedUsers.has(userId))) throw new StoreConflictError("同一用户不能进入两个最终局");
      const draft = state.drafts.find((item) => item.draftId === decision.draftId);
      const game = curatedGames.find((item) => item.id === decision.offlineGameId);
      validateFinalRoomDecision({
        decision,
        draft,
        choices: state.choices,
        requests: state.requests,
        game,
        hookSourceUserById: hookSources
      });
      if (!draft || !game) throw new StoreConflictError("候选局不可结算");
      const now = new Date().toISOString();
      const roomId = randomUUID();
      const room: MatchRoom = {
        roomId,
        members: decision.memberIds.map((userId) => ({
          userId,
          displayName: this.users.get(userId)?.displayName ?? "成员",
          confirmed: true,
          participationStatus: "confirmed"
        })),
        offlineGame: structuredClone(game),
        matchSummary: decision.summary,
        status: "confirmed",
        sourceDraftId: decision.draftId,
        targetPlayers: decision.targetPlayers,
        recruitmentStatus: decision.memberIds.length < Math.min(decision.targetPlayers, game.maxPlayers) ? "open" : "full",
        version: 0,
        meetingPoint: "TOMEET 集合点",
        matchingStatus: decision.memberIds.length < Math.min(decision.targetPlayers, game.maxPlayers)
          ? "active"
          : "full",
        capacity: Math.min(decision.targetPlayers, game.maxPlayers),
        createdAt: now,
        completedAt: null
      };
      this.rooms.set(roomId, room);
      draft.status = "formed";
      draft.version += 1;
      for (const [index, requestId] of decision.requestIds.entries()) {
        const request = this.matchRequests.get(requestId)!;
        request.status = "matched";
        request.phase = "settling";
        request.roomId = roomId;
        request.updatedAt = now;
        usedUsers.add(decision.memberIds[index]!);
      }
      roomIds.push(roomId);
    }
    const requestIds = this.roundRequests.get(roundId) ?? new Set<string>();
    for (const requestId of requestIds) {
      const request = this.matchRequests.get(requestId);
      if (request?.status === "matching" && request.activeRoundId === roundId) {
        const hadSelection = state.choices.some((choice) => choice.requestId === requestId);
        request.status = request.proactivePushEnabled || hadSelection ? "matching" : "expired";
        request.phase = request.proactivePushEnabled
          ? "watching"
          : hadSelection ? "push_consent" : "waiting";
        request.activeRoundId = null;
        request.optionsExpiresAt = null;
        request.updatedAt = new Date().toISOString();
      }
    }
    for (const offer of this.offers.values()) {
      if (offer.roundId === roundId && offer.status !== "accepted") offer.status = "expired";
    }
    round.status = "completed";
    round.updatedAt = new Date().toISOString();
    return roomIds;
  }

  async listSuitableOpenRooms(userId: string, limit = 3): Promise<MatchRoom[]> {
    return [...this.rooms.values()]
      .filter((room) => {
        if (room.status === "completed" || room.recruitmentStatus !== "open") return false;
        if (room.members.some((member) => member.userId === userId)) return false;
        const confirmed = room.members.filter((member) => member.participationStatus === "confirmed").length;
        const limitCount = Math.min(room.targetPlayers ?? room.offlineGame.maxPlayers, room.offlineGame.maxPlayers);
        return confirmed < limitCount;
      })
      .slice(0, Math.min(Math.max(limit, 1), 10))
      .map((room) => structuredClone(room));
  }

  private recordRoomChange(room: MatchRoom, changeType: string, payload: Record<string, unknown>): void {
    const eventId = randomUUID();
    for (const member of room.members.filter((item) => item.participationStatus === "confirmed")) {
      if (changeType === "member_joined" && payload.joinedUserId === member.userId) continue;
      const notification: RoomChangeNotification = {
        eventId,
        roomId: room.roomId,
        userId: member.userId,
        changeType,
        payload: structuredClone(payload),
        idempotencyKey: `room-change:${eventId}:${member.userId}`
      };
      this.roomNotifications.set(`${eventId}:${member.userId}`, notification);
    }
  }

  async joinOpenRoom(requestId: string, offerId: string, sourceVersion: number): Promise<MatchRoom> {
    const request = this.matchRequests.get(requestId);
    const offer = this.offers.get(offerId);
    if (!request || request.status !== "matching") throw new StoreConflictError("匹配请求已失效");
    if (!offer || offer.requestId !== requestId || offer.sourceType !== "open_room" || offer.status !== "accepted") {
      throw new StoreConflictError("用户没有接受这个开放局候选");
    }
    const room = offer.roomId ? this.rooms.get(offer.roomId) : null;
    if (!room) throw new StoreNotFoundError("开放局不存在");
    if (room.version !== sourceVersion || offer.sourceVersion !== sourceVersion) throw new StoreConflictError("开放局已经发生变化，请查看最新候选");
    if (room.recruitmentStatus !== "open") throw new StoreConflictError("开放局已经满员或关闭");
    const confirmed = room.members.filter((member) => member.participationStatus === "confirmed");
    const capacity = Math.min(room.targetPlayers ?? room.offlineGame.maxPlayers, room.offlineGame.maxPlayers);
    if (confirmed.length >= capacity) throw new StoreConflictError("开放局已经满员");
    const prior = room.members.find((member) => member.userId === request.userId);
    if (prior) {
      prior.confirmed = true;
      prior.participationStatus = "confirmed";
    } else {
      room.members.push({
        userId: request.userId,
        displayName: this.users.get(request.userId)?.displayName ?? "成员",
        confirmed: true,
        participationStatus: "confirmed"
      });
    }
    request.status = "matched";
    request.phase = "settling";
    request.roomId = room.roomId;
    request.updatedAt = new Date().toISOString();
    room.version += 1;
    const nextCount = confirmed.length + 1;
    room.status = nextCount >= room.offlineGame.minPlayers ? "confirmed" : "confirming";
    room.recruitmentStatus = nextCount >= capacity ? "full" : "open";
    this.recordRoomChange(room, "member_joined", { joinedUserId: request.userId, memberCount: nextCount });
    return structuredClone(room);
  }

  async getMatchInvite(inviteId: string): Promise<MatchInvite | null> {
    const record = this.matchInvites.get(inviteId);
    return record ? structuredClone(record.invite) : null;
  }

  async getLatestMatchInviteForUser(userId: string): Promise<MatchInvite | null> {
    const record = [...this.matchInvites.values()]
      .filter(({ invite }) => invite.participants.some((participant) => participant.userId === userId))
      .sort((a, b) => b.invite.createdAt.localeCompare(a.invite.createdAt))[0];
    return record ? structuredClone(record.invite) : null;
  }

  async createInitialMatchInvite(decision: MatchDecision, sourceJobId?: string): Promise<MatchInvite> {
    if (sourceJobId) {
      const existingId = this.sourceJobInvites.get(sourceJobId);
      if (existingId) return structuredClone(this.matchInvites.get(existingId)!.invite);
    }
    const requests = decision.requestIds.map((id) => this.matchRequests.get(id)).filter(Boolean) as MatchRequest[];
    const game = curatedGames.find((item) => item.id === decision.offlineGameId);
    validateMatchDecision(decision, requests, game);
    const inviteId = randomUUID();
    const now = new Date().toISOString();
    const participants = decision.memberIds.map((userId, index) => ({
      userId,
      requestId: decision.requestIds[index]!,
      displayName: this.users.get(userId)?.displayName ?? "成员",
      accepted: userId.startsWith("demo-")
    }));
    const invite: MatchInvite = {
      inviteId,
      kind: "initial_pair",
      roomId: null,
      participants,
      offlineGameId: decision.offlineGameId,
      matchSummary: decision.summary,
      status: "pending",
      createdAt: now,
      resolvedAt: null
    };
    this.matchInvites.set(inviteId, {
      invite,
      participantRequestIds: Object.fromEntries(
        participants.map((participant) => [participant.userId, participant.requestId])
      ),
      sourceJobId
    });
    if (sourceJobId) this.sourceJobInvites.set(sourceJobId, inviteId);
    for (const request of requests) {
      request.status = "invited";
      request.inviteId = inviteId;
      request.updatedAt = now;
    }
    return structuredClone(invite);
  }

  async createRoomJoinInvite(decision: RoomJoinDecision, sourceJobId?: string): Promise<MatchInvite> {
    if (sourceJobId) {
      const existingId = this.sourceJobInvites.get(sourceJobId);
      if (existingId) return structuredClone(this.matchInvites.get(existingId)!.invite);
    }
    const request = this.matchRequests.get(decision.requestId);
    const room = this.rooms.get(decision.roomId);
    validateRoomJoinDecision(decision, request ? [request] : [], room ? [room] : []);
    if ([...this.matchInvites.values()].some(
      ({ invite }) => invite.kind === "room_join"
        && invite.roomId === decision.roomId
        && invite.status === "pending"
    )) {
      throw new StoreConflictError("目标房间已有待处理邀请");
    }
    const inviteId = randomUUID();
    const now = new Date().toISOString();
    const participant = {
      userId: decision.userId,
      requestId: decision.requestId,
      displayName: this.users.get(decision.userId)?.displayName ?? "成员",
      accepted: decision.userId.startsWith("demo-")
    };
    const invite: MatchInvite = {
      inviteId,
      kind: "room_join",
      roomId: decision.roomId,
      participants: [participant],
      offlineGameId: room!.offlineGame.id,
      matchSummary: decision.summary,
      status: "pending",
      createdAt: now,
      resolvedAt: null
    };
    this.matchInvites.set(inviteId, {
      invite,
      participantRequestIds: { [participant.userId]: participant.requestId },
      sourceJobId
    });
    if (sourceJobId) this.sourceJobInvites.set(sourceJobId, inviteId);
    request!.status = "invited";
    request!.inviteId = inviteId;
    request!.updatedAt = now;
    if (participant.accepted) {
      return (await this.acceptMatchInvite(inviteId, participant.userId)).invite;
    }
    return structuredClone(invite);
  }

  async acceptMatchInvite(inviteId: string, userId: string): Promise<MatchInviteResolution> {
    const record = this.matchInvites.get(inviteId);
    if (!record) throw new StoreNotFoundError("匹配邀请不存在");
    const { invite } = record;
    const participant = invite.participants.find((item) => item.userId === userId);
    if (!participant) throw new StoreConflictError("用户不在该匹配邀请中");
    if (invite.status === "accepted") {
      return {
        invite: structuredClone(invite),
        room: invite.roomId ? structuredClone(this.rooms.get(invite.roomId) ?? null) : null,
        requeuedRequestIds: []
      };
    }
    if (invite.status !== "pending") throw new StoreConflictError("该匹配邀请已失效");
    participant.accepted = true;
    if (!invite.participants.every((item) => item.accepted)) {
      return { invite: structuredClone(invite), room: null, requeuedRequestIds: [] };
    }

    const now = new Date().toISOString();
    let room: MatchRoom;
    if (invite.kind === "initial_pair") {
      const game = curatedGames.find((item) => item.id === invite.offlineGameId);
      if (!game) throw new StoreNotFoundError("线下游戏不存在");
      const roomId = randomUUID();
      const capacity = game.maxPlayers;
      room = {
        roomId,
        members: invite.participants.map((item) => ({
          userId: item.userId,
          displayName: item.displayName,
          confirmed: true,
          participationStatus: "confirmed"
        })),
        offlineGame: structuredClone(game),
        matchSummary: invite.matchSummary,
        status: "confirmed",
        sourceDraftId: null,
        targetPlayers: capacity,
        recruitmentStatus: invite.participants.length >= capacity ? "full" : "open",
        version: 0,
        meetingPoint: null,
        matchingStatus: invite.participants.length >= capacity ? "full" : "active",
        capacity,
        createdAt: now,
        completedAt: null
      };
      this.rooms.set(roomId, room);
      invite.roomId = roomId;
      for (const requestId of Object.values(record.participantRequestIds)) {
        const request = this.matchRequests.get(requestId);
        if (!request) continue;
        request.status = "matched";
        request.phase = "settling";
        request.roomId = roomId;
        request.updatedAt = now;
        const user = this.users.get(request.userId);
        if (user && !user.model.socialHistory.includes(roomId)) {
          user.model.socialHistory = [...user.model.socialHistory, roomId].slice(-50);
          user.model.version += 1;
          user.model.updatedAt = now;
        }
      }
    } else {
      room = this.rooms.get(invite.roomId!)!;
      const activeMembers = room?.members.filter((member) => member.participationStatus !== "withdrawn") ?? [];
      if (!room || room.status === "completed" || room.matchingStatus !== "active") {
        throw new StoreConflictError("目标房间已停止匹配");
      }
      if (activeMembers.length >= room.capacity) {
        room.matchingStatus = "full";
        room.recruitmentStatus = "full";
        throw new StoreConflictError("目标房间已满");
      }
      const existing = room.members.find((member) => member.userId === participant.userId);
      if (existing) {
        existing.confirmed = true;
        existing.participationStatus = "confirmed";
      } else {
        room.members.push({
          userId: participant.userId,
          displayName: participant.displayName,
          confirmed: true,
          participationStatus: "confirmed"
        });
      }
      const request = this.matchRequests.get(participant.requestId)!;
      request.status = "matched";
      request.phase = "settling";
      request.roomId = room.roomId;
      request.updatedAt = now;
      room.version += 1;
      const memberCount = room.members.filter((member) => member.participationStatus !== "withdrawn").length;
      if (memberCount >= room.capacity) {
        room.matchingStatus = "full";
        room.recruitmentStatus = "full";
      }
      this.recordRoomChange(room, "member_joined", {
        joinedUserId: participant.userId,
        memberCount
      });
      const user = this.users.get(participant.userId);
      if (user && !user.model.socialHistory.includes(room.roomId)) {
        user.model.socialHistory = [...user.model.socialHistory, room.roomId].slice(-50);
        user.model.version += 1;
        user.model.updatedAt = now;
      }
    }
    invite.status = "accepted";
    invite.resolvedAt = now;
    return {
      invite: structuredClone(invite),
      room: structuredClone(room),
      requeuedRequestIds: []
    };
  }

  async declineMatchInvite(inviteId: string, userId: string): Promise<MatchInviteResolution> {
    const record = this.matchInvites.get(inviteId);
    if (!record) throw new StoreNotFoundError("匹配邀请不存在");
    const { invite } = record;
    const participant = invite.participants.find((item) => item.userId === userId);
    if (!participant) throw new StoreConflictError("用户不在该匹配邀请中");
    if (invite.status !== "pending") throw new StoreConflictError("该匹配邀请已失效");
    const now = new Date().toISOString();
    const request = this.matchRequests.get(participant.requestId);
    if (request) {
      request.status = "cancelled";
      request.phase = "waiting";
      request.inviteId = null;
      request.updatedAt = now;
    }
    const requeuedRequestIds: string[] = [];
    if (invite.kind === "initial_pair") {
      for (const other of invite.participants.filter((item) => item.userId !== userId)) {
        const otherRequest = this.matchRequests.get(other.requestId);
        if (!otherRequest || otherRequest.status !== "invited") continue;
        otherRequest.status = "matching";
        otherRequest.phase = "waiting";
        otherRequest.activeRoundId = null;
        otherRequest.optionsExpiresAt = null;
        otherRequest.inviteId = null;
        otherRequest.updatedAt = now;
        requeuedRequestIds.push(otherRequest.requestId);
      }
    }
    invite.status = "declined";
    invite.resolvedAt = now;
    return {
      invite: structuredClone(invite),
      room: invite.roomId ? structuredClone(this.rooms.get(invite.roomId) ?? null) : null,
      requeuedRequestIds
    };
  }

  async listMatchCandidates(limit = 50): Promise<MatchCandidate[]> {
    const requests = [...this.matchRequests.values()]
      .filter((request) => request.status === "matching")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    return requests.map((request) => ({
      request: structuredClone(request),
      userModel: structuredClone(this.users.get(request.userId)!.model),
      matchingNarrative: this.memoryProfiles.get(request.userId)?.stale
        ? this.memoryProfiles.get(request.userId)?.version === 0
          ? this.users.get(request.userId)!.model.vibeNarrative
          : ""
        : this.memoryProfiles.get(request.userId)?.version === 0
          ? this.memoryProfiles.get(request.userId)?.matchingNarrative
            || this.users.get(request.userId)!.model.vibeNarrative
          : this.memoryProfiles.get(request.userId)?.matchingNarrative ?? "",
      socialHooks: [...this.socialHooks.values()]
        .filter((hook) => hook.userId === request.userId && hook.status === "active")
        .map((hook) => structuredClone(hook))
    }));
  }

  async listOpenRoomsForMatching(limit = 20): Promise<RoomMatchCandidate[]> {
    return [...this.rooms.values()]
      .filter((room) => {
        const memberCount = room.members.filter(
          (member) => member.participationStatus !== "withdrawn"
        ).length;
        return room.status !== "completed"
          && room.matchingStatus === "active"
          && memberCount < room.capacity
          && ![...this.matchInvites.values()].some(
            ({ invite }) => invite.kind === "room_join"
              && invite.roomId === room.roomId
              && invite.status === "pending"
          );
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((room) => ({
        room: structuredClone(room),
        members: room.members
          .filter((member) => member.participationStatus !== "withdrawn")
          .flatMap((member) => {
            const request = [...this.matchRequests.values()]
              .filter((item) => item.userId === member.userId && item.roomId === room.roomId)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            if (!request) return [];
            return [{
              request: structuredClone(request),
              userModel: structuredClone(this.users.get(member.userId)!.model),
              matchingNarrative: this.memoryProfiles.get(member.userId)?.matchingNarrative
                || this.users.get(member.userId)!.model.vibeNarrative,
              socialHooks: [...this.socialHooks.values()]
                .filter((hook) => hook.userId === member.userId && hook.status === "active")
                .map((hook) => structuredClone(hook))
            }];
          })
      }));
  }

  async listOfflineGames(): Promise<OfflineGame[]> {
    return structuredClone(curatedGames);
  }

  async getRoom(roomId: string): Promise<MatchRoom | null> {
    const room = this.rooms.get(roomId);
    return room ? structuredClone(room) : null;
  }

  async getLatestRoomForUser(userId: string): Promise<MatchRoom | null> {
    const rooms = [...this.rooms.values()]
      .filter((item) => item.members.some((member) => member.userId === userId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!rooms) return null;
    const membership = rooms.members.find((member) => member.userId === userId);
    if (rooms.status !== "completed" && membership?.participationStatus === "withdrawn") return null;
    return structuredClone(rooms);
  }

  async confirmRoom(roomId: string, userId: string): Promise<MatchRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new StoreNotFoundError("房间不存在");
    if (room.status === "completed") throw new StoreConflictError("活动已完成");
    const member = room.members.find((item) => item.userId === userId);
    if (!member) throw new StoreConflictError("用户不在房间中");
    member.confirmed = true;
    member.participationStatus = "confirmed";
    if (room.members.filter((item) => item.participationStatus !== "withdrawn").every((item) => item.confirmed)) room.status = "confirmed";
    return structuredClone(room);
  }

  async leaveRoom(roomId: string, userId: string, reason?: string): Promise<MatchRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new StoreNotFoundError("房间不存在");
    if (room.status === "completed") throw new StoreConflictError("活动已完成");
    const member = room.members.find((item) => item.userId === userId && item.participationStatus !== "withdrawn");
    if (!member) throw new StoreConflictError("用户不在当前房间中");
    const normalizedReason = reason?.trim() ?? "";
    if ((room.status === "confirmed" || member.confirmed) && normalizedReason.length === 0) {
      throw new StoreConflictError("正式成局后退出需要说明一个理由");
    }
    if (normalizedReason.length > 500) throw new StoreConflictError("退出理由不能超过 500 字");
    if (normalizedReason) this.roomWithdrawalReasons.set(`${roomId}:${userId}`, normalizedReason);
    member.confirmed = false;
    member.participationStatus = "withdrawn";
    room.version += 1;
    const remaining = room.members.filter((item) => item.participationStatus === "confirmed").length;
    room.status = remaining >= room.offlineGame.minPlayers ? "confirmed" : "confirming";
    if (remaining < room.capacity && room.matchingStatus !== "stopped") {
      room.recruitmentStatus = "open";
      room.matchingStatus = "active";
    }
    const request = [...this.matchRequests.values()].find((item) => item.roomId === roomId && item.userId === userId);
    if (request) {
      request.status = request.proactivePushEnabled ? "matching" : "cancelled";
      request.phase = request.proactivePushEnabled ? "watching" : "waiting";
      request.roomId = null;
      request.activeRoundId = null;
      request.optionsExpiresAt = null;
      request.inviteId = null;
      request.updatedAt = new Date().toISOString();
    }
    this.recordRoomChange(room, "member_withdrawn", { withdrawnUserId: userId, memberCount: remaining });
    return structuredClone(room);
  }

  async getRoomIntro(roomId: string, userId: string): Promise<string | null> {
    return this.roomIntros.get(`${roomId}:${userId}`) ?? null;
  }

  async saveRoomIntro(roomId: string, userId: string, introText: string, hookIds: string[]): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.some((member) => member.userId === userId && member.participationStatus === "confirmed")) {
      throw new StoreNotFoundError("房间成员不存在");
    }
    const confirmedUserIds = new Set(room.members
      .filter((member) => member.participationStatus === "confirmed")
      .map((member) => member.userId));
    for (const hookId of hookIds) {
      const hook = this.socialHooks.get(hookId);
      if (!hook || hook.status !== "active" || hook.userId === userId || !confirmedUserIds.has(hook.userId)) {
        throw new StoreConflictError("房间介绍引用了无效人物事实");
      }
    }
    this.roomIntros.set(`${roomId}:${userId}`, introText);
  }

  async listPendingRoomChangeNotifications(limit = 100): Promise<RoomChangeNotification[]> {
    return [...this.roomNotifications.entries()]
      .filter(([key]) => !this.deliveredRoomNotifications.has(key))
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(([, notification]) => structuredClone(notification));
  }

  async markRoomChangeNotificationDelivered(eventId: string, userId: string): Promise<void> {
    const key = `${eventId}:${userId}`;
    if (!this.roomNotifications.has(key)) throw new StoreNotFoundError("房间变化通知不存在");
    this.deliveredRoomNotifications.add(key);
  }

  async listPendingDraftChangeNotifications(limit = 100): Promise<DraftChangeNotification[]> {
    return [...this.draftNotifications.entries()]
      .filter(([key]) => !this.deliveredDraftNotifications.has(key))
      .slice(0, Math.min(Math.max(limit, 1), 500))
      .map(([, notification]) => structuredClone(notification));
  }

  async markDraftChangeNotificationDelivered(eventId: string, userId: string): Promise<void> {
    const key = `${eventId}:${userId}`;
    if (!this.draftNotifications.has(key)) throw new StoreNotFoundError("候选局变化通知不存在");
    this.deliveredDraftNotifications.add(key);
  }

  async stopRoomMatching(roomId: string, userId: string): Promise<StopRoomMatchingResult> {
    const room = this.rooms.get(roomId);
    if (!room || room.status === "completed") throw new StoreNotFoundError("房间不存在或已经结束");
    if (!room.members.some(
      (member) => member.userId === userId && member.participationStatus !== "withdrawn"
    )) {
      throw new StoreConflictError("用户不在房间中");
    }
    if (room.matchingStatus === "active") room.matchingStatus = "stopped";
    if (room.recruitmentStatus === "open") room.recruitmentStatus = "closed";
    const now = new Date().toISOString();
    const requeuedRequestIds: string[] = [];
    for (const { invite } of this.matchInvites.values()) {
      if (invite.kind !== "room_join" || invite.roomId !== roomId || invite.status !== "pending") continue;
      invite.status = "cancelled";
      invite.resolvedAt = now;
      for (const participant of invite.participants) {
        const request = this.matchRequests.get(participant.requestId);
        if (!request || request.status !== "invited") continue;
        request.status = "matching";
        request.phase = "waiting";
        request.activeRoundId = null;
        request.optionsExpiresAt = null;
        request.inviteId = null;
        request.updatedAt = now;
        requeuedRequestIds.push(request.requestId);
      }
    }
    return { room: structuredClone(room), requeuedRequestIds };
  }

  async completeRoom(roomId: string): Promise<MatchRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new StoreNotFoundError("房间不存在");
    if (room.status === "completed") return structuredClone(room);
    if (!room.members.filter((member) => member.participationStatus !== "withdrawn").every((member) => member.confirmed)) {
      throw new StoreConflictError("所有成员确认后才能完成活动");
    }
    room.status = "completed";
    if (room.matchingStatus !== "full") room.matchingStatus = "stopped";
    room.recruitmentStatus = room.matchingStatus === "full" ? "full" : "closed";
    room.completedAt ??= new Date().toISOString();
    for (const member of room.members) {
      const user = this.users.get(member.userId);
      if (!user) continue;
      user.model.currentIntent = {};
      user.model.version += 1;
      user.model.updatedAt = new Date().toISOString();
    }
    return structuredClone(room);
  }

  async saveFeedback(feedback: PostEventFeedback): Promise<string> {
    const room = this.rooms.get(feedback.roomId);
    if (!room) throw new StoreNotFoundError("房间不存在");
    if (room.status !== "completed") throw new StoreConflictError("活动完成后才能提交反馈");
    if (!room.members.some((member) => member.userId === feedback.userId)) throw new StoreConflictError("用户不在房间中");
    if (feedback.connectionUserIds.some((userId) => userId === feedback.userId)) {
      throw new StoreConflictError("连接用户不能包含自己");
    }
    if (feedback.connectionUserIds.some((userId) => !room.members.some((member) => member.userId === userId))) {
      throw new StoreConflictError("连接用户必须是本次房间成员");
    }
    const key = `${feedback.roomId}:${feedback.userId}`;
    const existing = this.feedbackKeys.get(key);
    if (existing) return existing;
    const id = randomUUID();
    this.feedbackKeys.set(key, id);
    return id;
  }

  async enqueueWechatOutboundMessage(message: Message): Promise<void> {
    if (message.sourceChannel === "web") {
      throw new StoreConflictError("Web 对话消息不能投递到微信");
    }
    this.wechatOutboundMessages.set(message.id, structuredClone(message));
  }

  async enqueueJob(input: EnqueueJobInput): Promise<LlmJob> {
    const existingId = this.jobKeys.get(input.idempotencyKey);
    if (existingId) return structuredClone(this.jobs.get(existingId)!);
    const now = new Date().toISOString();
    const job: LlmJob = {
      id: randomUUID(),
      type: input.type,
      status: "pending",
      payload: structuredClone(input.payload),
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      partitionKey: input.partitionKey ?? null,
      runAt: input.runAt ?? now,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(job.id, job);
    this.jobKeys.set(input.idempotencyKey, job.id);
    return structuredClone(job);
  }

  async getJob(jobId: string): Promise<LlmJob | null> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  async claimJob(_workerId: string): Promise<LlmJob | null> {
    const processingPartitions = new Set(
      [...this.jobs.values()]
        .filter((item) => item.status === "processing" && item.partitionKey)
        .map((item) => item.partitionKey)
    );
    const job = [...this.jobs.values()]
      .filter((item) =>
        (item.status === "pending" || item.status === "retry")
        && new Date(item.runAt).getTime() <= Date.now()
        && (!item.partitionKey || !processingPartitions.has(item.partitionKey))
      )
      .sort((left, right) => left.runAt.localeCompare(right.runAt) || left.createdAt.localeCompare(right.createdAt))[0];
    if (!job) return null;
    job.status = "processing";
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    return structuredClone(job);
  }

  async completeJob(jobId: string, result: Record<string, unknown>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new StoreNotFoundError("任务不存在");
    job.status = "completed";
    job.result = structuredClone(result);
    job.error = null;
    job.updatedAt = new Date().toISOString();
  }

  async failJob(jobId: string, error: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new StoreNotFoundError("任务不存在");
    job.status = job.attempts >= job.maxAttempts ? "failed" : "retry";
    job.error = error;
    job.updatedAt = new Date().toISOString();
  }

  async ping(): Promise<void> {}
}
