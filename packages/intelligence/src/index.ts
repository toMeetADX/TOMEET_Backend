import {
  buildAgentContext,
  containsSensitivePersonalData,
  countRecentMessagesToKeep,
  sanitizeMemoryCandidates,
  selectRelevantMemories,
  truncateToEstimatedTokens,
  type AgentAction,
  type AgentIntelligence
} from "@tomeet/agent-core";
import {
  adventurexWelcomeContent,
  agentProductEventSchema,
  postEventFeedbackSchema,
  userMemorySourceTypeSchema,
  type LlmJob,
  type AgentProductEvent,
  type AgentProductMessage,
  type FinalRoomDecision,
  type MatchRequest,
  type MatchRoundProposal,
  type MatchRoom,
  type UserMemoryProfile,
  type UserModel
} from "@tomeet/contracts";
import type { DataStore } from "@tomeet/data";
import { StoreConflictError, StoreNotFoundError } from "@tomeet/data";
import { updateModelFromFeedback } from "@tomeet/feedback";
import {
  generateFinalGroupCandidates,
  formatCandidatePreview,
  MATCH_UTILITY_WEIGHTS,
  selectNonOverlappingGroups,
  type MatchCandidate,
  type MatchmakingIntelligence,
  validateMatchDecision,
  validateMatchRoundProposal
} from "@tomeet/matchmaking";
import { applyConversationInsight, applyMultimodalInsight } from "@tomeet/user-model";

export * from "./hosted-llm.js";
export * from "./web-search.js";
export { buildAgentContext } from "@tomeet/agent-core";

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`任务缺少 ${key}`);
  return value;
}

export async function scheduleAdventurexMatchRequest(
  store: DataStore,
  request: MatchRequest,
  options: { roundBucketSeconds?: number; now?: Date } = {}
): Promise<{ round: import("@tomeet/contracts").MatchRound; job: LlmJob }> {
  const bucketMs = (options.roundBucketSeconds ?? 30) * 1_000;
  const now = options.now?.getTime() ?? Date.now();
  const scheduledAt = new Date(Math.ceil((now + 1) / bucketMs) * bucketMs).toISOString();
  const testPool = await store.getAdventurexTestPoolStatus(request.userId);
  const testRequests = testPool.enabled
    ? await store.prepareAdventurexTestPool(request.userId)
    : [];
  const bucketKey = testPool.enabled
    ? `adventurex-test:${request.userId}:${scheduledAt}`
    : `adventurex:${scheduledAt}`;
  const round = await store.createOrGetMatchRound(bucketKey, scheduledAt);
  const requests = [request, ...testRequests];
  for (const candidateRequest of new Map(
    requests.map((item) => [item.requestId, item])
  ).values()) {
    await store.addRequestToRound(round.roundId, candidateRequest.requestId);
  }
  const job = await store.enqueueJob({
    type: "match_round_generate",
    payload: { roundId: round.roundId },
    idempotencyKey: `match-round-generate:${round.roundId}`,
    partitionKey: `match-round:${round.roundId}`,
    runAt: scheduledAt
  });
  return { round, job };
}

export async function scheduleAdventurexClearingTick(
  store: DataStore,
  options: { roundBucketSeconds?: number; now?: Date } = {}
): Promise<{ round: import("@tomeet/contracts").MatchRound; job: LlmJob }> {
  const bucketMs = (options.roundBucketSeconds ?? 30) * 1_000;
  const now = options.now?.getTime() ?? Date.now();
  const scheduledAt = new Date(Math.ceil((now + 1) / bucketMs) * bucketMs).toISOString();
  const round = await store.createOrGetMatchRound(`adventurex-recall:${scheduledAt}`, scheduledAt);
  const job = await store.enqueueJob({
    type: "match_round_generate",
    payload: { roundId: round.roundId },
    idempotencyKey: `match-round-generate:${round.roundId}`,
    partitionKey: `match-round:${round.roundId}`,
    runAt: scheduledAt
  });
  return { round, job };
}

export class JobProcessor {
  constructor(
    private readonly store: DataStore,
    private readonly agent: AgentIntelligence,
    private readonly matchmaking: MatchmakingIntelligence,
    private readonly options: {
      adventurexMatchingV1?: boolean;
      roundBucketSeconds?: number;
      offerWindowSeconds?: number;
    } = {}
  ) {}

  async process(job: LlmJob): Promise<Record<string, unknown>> {
    switch (job.type) {
      case "agent_reply":
        return this.processAgentReply(job);
      case "agent_event_reply":
        return this.processAgentEventReply(job);
      case "multimodal_understanding":
        return this.processMultimodal(job);
      case "matchmaking":
        return this.processMatchmaking(job);
      case "match_round_generate":
        return this.processMatchRoundGenerate(job);
      case "match_round_settle":
        return this.processMatchRoundSettle(job);
      case "room_change_notify":
        return this.processRoomChangeNotify();
      case "feedback_update":
        return this.processFeedback(job);
      case "memory_extract":
        return this.processMemoryExtract(job);
      case "memory_consolidate":
        return this.processMemoryConsolidate(job);
    }
    throw new Error(`不支持的任务类型：${job.type}`);
  }

  private get adventurexMatchingV1(): boolean {
    return this.options.adventurexMatchingV1 ?? false;
  }

  private async scheduleMatchRequest(request: MatchRequest): Promise<{ roundId: string; jobId: string }> {
    const scheduled = await scheduleAdventurexMatchRequest(this.store, request, {
      roundBucketSeconds: this.options.roundBucketSeconds
    });
    return { roundId: scheduled.round.roundId, jobId: scheduled.job.id };
  }

  private async buildProductContext(userId: string) {
    const [model, matchRequest, room, memoryProfile, matchOptions, onboardingState, messages] = await Promise.all([
      this.store.getUserModel(userId),
      this.store.getLatestMatchRequestForUser(userId),
      this.store.getLatestRoomForUser(userId),
      this.store.getMemoryProfile(userId),
      this.store.listCurrentMatchOptions(userId),
      this.store.ensureAdventurexOnboardingState(userId),
      this.store.listRecentMessages(userId, 32)
    ]);
    return buildAgentContext(messages, model, {
      matchRequest,
      room,
      memoryProfile,
      matchOptions,
      onboardingState
    });
  }

  private async composeProductMessage(userId: string, event: AgentProductEvent): Promise<AgentProductMessage> {
    return this.agent.composeProductMessage(await this.buildProductContext(userId), event);
  }

  private async appendProactiveMessage(input: {
    userId: string;
    content: string;
    idempotencyKey: string;
  }) {
    const message = await this.store.appendMessage({
      userId: input.userId,
      role: "assistant",
      content: input.content,
      idempotencyKey: input.idempotencyKey
    });
    await this.store.enqueueWechatOutboundMessage(message);
    return message;
  }

  private async appendProactiveProductMessage(input: {
    userId: string;
    event: AgentProductEvent;
    idempotencyKey: string;
  }) {
    const composed = await this.composeProductMessage(input.userId, input.event);
    const message = await this.appendProactiveMessage({
      userId: input.userId,
      content: composed.content,
      idempotencyKey: input.idempotencyKey
    });
    return { composed, message };
  }

  private async processAgentEventReply(job: LlmJob): Promise<Record<string, unknown>> {
    const userId = requireString(job.payload, "userId");
    const event = agentProductEventSchema.parse(job.payload.event);
    const idempotencyKey = requireString(job.payload, "messageIdempotencyKey");
    const composed = await this.composeProductMessage(userId, event);
    const message = await this.store.appendMessage({
      userId,
      role: "assistant",
      content: composed.content,
      idempotencyKey
    });
    return { message, eventKind: event.kind };
  }

  private async saveModelWithRetry(
    userId: string,
    transform: (current: UserModel) => UserModel
  ): Promise<UserModel> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.store.getUserModel(userId);
      try {
        return await this.store.saveUserModel(transform(current), current.version);
      } catch (error) {
        lastError = error;
        if (!(error instanceof StoreConflictError)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("更新用户模型冲突");
  }

  private async processAgentReply(job: LlmJob): Promise<Record<string, unknown>> {
    const userId = requireString(job.payload, "userId");
    const userContent = requireString(job.payload, "content");
    const userMessageId = requireString(job.payload, "userMessageId");
    const [model, initialMatchRequest, initialRoom, memoryProfile, matchOptions, onboardingState] = await Promise.all([
      this.store.getUserModel(userId),
      this.store.getLatestMatchRequestForUser(userId),
      this.store.getLatestRoomForUser(userId),
      this.store.getMemoryProfile(userId),
      this.store.listCurrentMatchOptions(userId),
      this.store.ensureAdventurexOnboardingState(userId)
    ]);
    const [messages, checkpoint] = await Promise.all([
      this.store.listRecentMessages(userId, 32),
      this.updateConversationCheckpoint(userId)
    ]);
    const context = buildAgentContext(messages, model, {
      matchRequest: initialMatchRequest,
      room: initialRoom,
      checkpoint,
      memoryProfile,
      matchOptions,
      onboardingState,
      excludeMessageId: userMessageId
    });
    const insight = await this.agent.reply(
      context,
      userContent,
      async (queries) => selectRelevantMemories(
        await this.store.listActiveMemories(userId, 128),
        queries,
        6
      ),
      userMessageId
    );
    let onboardingReplyOverride: string | null = null;
    if (insight.onboardingTransition === "image_declined") {
      await this.store.updateAdventurexOnboardingState(userId, { stage: "exploring", imageDeclined: true });
    } else if (insight.onboardingTransition === "engaged") {
      await this.store.updateAdventurexOnboardingState(userId, { stage: "exploring" });
    } else if (insight.onboardingTransition === "boundary_prompted") {
      await this.store.updateAdventurexOnboardingState(userId, { boundaryPrompted: true });
    } else if (insight.onboardingTransition === "language_en") {
      await this.store.updateAdventurexOnboardingState(userId, { preferredLanguage: "en" });
      onboardingReplyOverride = adventurexWelcomeContent("en");
    } else if (insight.onboardingTransition === "language_zh") {
      await this.store.updateAdventurexOnboardingState(userId, { preferredLanguage: "zh" });
      onboardingReplyOverride = adventurexWelcomeContent("zh");
    }
    const messageIds = new Set((await this.store.listRecentMessages(userId, 100))
      .filter((message) => message.role === "user")
      .map((message) => message.id));
    const validSocialHooks = insight.socialHooks.filter((hook) =>
      hook.evidenceMessageIds.every((messageId) => messageIds.has(messageId))
    );
    const savedSocialHooks = await this.store.saveSocialHooks(userId, validSocialHooks);
    await this.store.recordMemoryUsage(userId, insight.usedMemoryIds);
    const currentIntent = insight.currentIntent && insight.socialIntentDetected
      ? {
          ...insight.currentIntent,
          socialIntentConfirmed: true,
          confirmedAt: new Date().toISOString()
        }
      : insight.currentIntent;
    const updatedModel = await this.saveModelWithRetry(userId, (current) =>
      applyConversationInsight(current, {
        currentIntent
      })
    );
    const actionResults: Array<Record<string, unknown>> = [];
    let matchRequest = initialMatchRequest;
    let room = initialRoom;
    for (const action of insight.actions) {
      try {
        const result = await this.executeAgentAction(job, userId, action, updatedModel, matchRequest, room);
        actionResults.push({ type: action.type, ok: true, ...result.result, replyOverride: result.replyOverride });
        matchRequest = result.matchRequest;
        room = result.room;
      } catch (error) {
        if (!(error instanceof StoreConflictError) && !(error instanceof StoreNotFoundError)) throw error;
        actionResults.push({ type: action.type, ok: false, error: error.message });
      }
    }
    const actionErrors = actionResults.filter((result) => result.ok === false).map((result) => result.error);
    const replyOverride = actionResults.find((result) => typeof result.replyOverride === "string")?.replyOverride;
    const replyContent = onboardingReplyOverride ?? (actionErrors.length
      ? `${insight.reply}\n\n不过这次操作暂时没有完成：${actionErrors.join("；")}`
      : typeof replyOverride === "string" ? replyOverride : insight.reply);
    const message = await this.store.appendMessage({
      userId,
      role: "assistant",
      content: replyContent,
      idempotencyKey: `agent-reply:${job.id}`
    });
    const memoryJob = await this.store.enqueueJob({
      type: "memory_extract",
      payload: {
        userId,
        sourceType: "message",
        sourceId: userMessageId,
        content: userContent,
        assistantReply: replyContent,
        memoryReviewSuggested: insight.memoryReviewSuggested
      },
      idempotencyKey: `memory:message:${userMessageId}`,
      partitionKey: `user:${userId}`
    });
    return {
      message,
      userModel: updatedModel,
      socialIntentDetected: insight.socialIntentDetected,
      webSearch: insight.webSearch,
      actions: actionResults,
      matchRequest,
      room,
      memoryJobId: memoryJob.id,
      contextBudget: context.budget,
      usedMemoryCount: insight.usedMemoryIds.length,
      savedSocialHookCount: savedSocialHooks.length
    };
  }

  private async updateConversationCheckpoint(userId: string): Promise<string> {
    let state = await this.store.getConversationState(userId);
    const messageCount = await this.store.countMessages(userId);
    const recentMessages = await this.store.listRecentMessages(userId, 100);
    const keepCount = countRecentMessagesToKeep(recentMessages, 16, 4_000);
    const targetCount = Math.max(0, messageCount - keepCount);

    while (state.summarizedMessageCount < targetCount) {
      const batchSize = Math.min(100, targetCount - state.summarizedMessageCount);
      const messages = await this.store.listMessagesRange(userId, state.summarizedMessageCount, batchSize);
      if (messages.length === 0) break;
      const summary = await this.agent.summarizeConversation(state.rollingSummary, messages);
      const nextCount = state.summarizedMessageCount + messages.length;
      try {
        await this.store.saveConversationSummary(
          userId,
          summary,
          nextCount,
          state.summarizedMessageCount
        );
        state = { rollingSummary: summary, summarizedMessageCount: nextCount };
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error;
        state = await this.store.getConversationState(userId);
      }
    }

    return state.rollingSummary;
  }

  private async executeAgentAction(
    job: LlmJob,
    userId: string,
    action: AgentAction,
    userModel: UserModel,
    currentMatchRequest: MatchRequest | null,
    currentRoom: MatchRoom | null
  ): Promise<{
    result: Record<string, unknown>;
    matchRequest: MatchRequest | null;
    room: MatchRoom | null;
    replyOverride?: string;
  }> {
    switch (action.type) {
      case "start_match": {
        if (currentRoom && currentRoom.status !== "completed") {
          throw new StoreConflictError("你还有一个未结束的匹配房间");
        }
        const intent = Object.keys(action.intent).length
          ? {
              ...action.intent,
              socialIntentConfirmed: true,
              confirmedAt: userModel.currentIntent.confirmedAt ?? new Date().toISOString()
            }
          : userModel.currentIntent;
        const matchRequest = currentMatchRequest?.status === "matching"
          ? currentMatchRequest
          : await this.store.createMatchRequest(userId, intent);
        const scheduled = this.adventurexMatchingV1
          ? await this.scheduleMatchRequest(matchRequest)
          : await this.store.enqueueJob({
              type: "matchmaking",
              payload: { requestId: matchRequest.requestId },
              idempotencyKey: `match:${matchRequest.requestId}`,
              partitionKey: `user:${userId}`
            }).then((queued) => ({ roundId: null, jobId: queued.id }));
        if (this.adventurexMatchingV1) {
          await this.store.updateAdventurexOnboardingState(userId, { stage: "matching" });
        }
        return {
          result: { matchRequest, jobId: scheduled.jobId, roundId: scheduled.roundId },
          matchRequest,
          room: currentRoom
        };
      }
      case "select_match_options": {
        if (!currentMatchRequest || currentMatchRequest.status !== "matching") {
          throw new StoreNotFoundError("当前没有可以选择的候选");
        }
        const choices = await this.store.saveMatchChoices(currentMatchRequest.requestId, {
          preferredOptionNumber: action.preferredOptionNumber,
          acceptedOptionNumbers: action.acceptedOptionNumbers,
          requiredHookIds: action.requiredHookIds,
          rawText: action.rawText
        });
        const options = await this.store.listCurrentMatchOptions(userId);
        const preferredChoice = choices.find((choice) => choice.preferenceRank === 1 && choice.sourceType === "open_room");
        if (preferredChoice && options) {
          const offer = options.options.find((item) => item.roomId === preferredChoice.roomId);
          if (!offer) throw new StoreConflictError("开放局候选已经变化");
          const room = await this.store.joinOpenRoom(currentMatchRequest.requestId, offer.offerId, offer.sourceVersion);
          const intro = await this.composeRoomIntro(room, userId);
          const notifyJob = await this.store.enqueueJob({
            type: "room_change_notify",
            payload: { roomId: room.roomId },
            idempotencyKey: `room-change-notify:${room.roomId}:${room.version}`,
            partitionKey: `room:${room.roomId}`
          });
          return {
            result: { choices, room, jobId: notifyJob.id },
            matchRequest: await this.store.getMatchRequest(currentMatchRequest.requestId),
            room,
            replyOverride: intro
          };
        }
        return { result: { choices }, matchRequest: await this.store.getMatchRequest(currentMatchRequest.requestId), room: currentRoom };
      }
      case "refresh_match_options": {
        if (!currentMatchRequest || currentMatchRequest.status !== "matching") throw new StoreNotFoundError("当前没有可刷新的匹配");
        await this.store.expireMatchOptions(currentMatchRequest.requestId);
        const request = await this.store.getMatchRequest(currentMatchRequest.requestId);
        if (!request) throw new StoreNotFoundError("匹配请求不存在");
        const scheduled = await this.scheduleMatchRequest(request);
        return { result: scheduled, matchRequest: request, room: currentRoom };
      }
      case "cancel_match": {
        if (!currentMatchRequest) throw new StoreNotFoundError("当前没有可以取消的匹配");
        const request = await this.store.cancelMatchRequest(currentMatchRequest.requestId);
        return { result: { matchRequest: request, canRematch: true }, matchRequest: request, room: currentRoom };
      }
      case "restart_match": {
        if (!currentMatchRequest) throw new StoreNotFoundError("没有可重新开始的匹配记录");
        const request = await this.store.restartMatch(currentMatchRequest.requestId);
        const scheduled = await this.scheduleMatchRequest(request);
        return { result: { matchRequest: request, ...scheduled }, matchRequest: request, room: currentRoom };
      }
      case "enable_match_push": {
        if (!currentMatchRequest || currentMatchRequest.status !== "matching") {
          throw new StoreNotFoundError("当前没有可以持续留意的匹配");
        }
        const request = await this.store.setMatchRequestInterest(currentMatchRequest.requestId, {
          phase: "watching",
          proactivePushEnabled: true,
          clearRound: true
        });
        return {
          result: { matchRequest: request, proactivePushEnabled: true },
          matchRequest: request,
          room: currentRoom
        };
      }
      case "disable_match_push": {
        if (!currentMatchRequest || currentMatchRequest.status !== "matching") {
          throw new StoreNotFoundError("当前没有可以停止的主动匹配提醒");
        }
        const request = await this.store.cancelMatchRequest(currentMatchRequest.requestId);
        return {
          result: { matchRequest: request, proactivePushEnabled: false, canRematch: true },
          matchRequest: request,
          room: currentRoom
        };
      }
      case "activate_match": {
        if (!currentMatchRequest || currentMatchRequest.status !== "matching") {
          throw new StoreNotFoundError("当前没有可以重新激活的匹配");
        }
        const request = await this.store.setMatchRequestInterest(currentMatchRequest.requestId, {
          phase: "waiting",
          proactivePushEnabled: currentMatchRequest.proactivePushEnabled,
          clearRound: true
        });
        const scheduled = await this.scheduleMatchRequest(request);
        return {
          result: { matchRequest: request, ...scheduled },
          matchRequest: request,
          room: currentRoom
        };
      }
      case "leave_room": {
        if (!currentRoom) throw new StoreNotFoundError("当前没有可以退出的房间");
        const room = await this.store.leaveRoom(currentRoom.roomId, userId, action.reason);
        const notifyJob = await this.store.enqueueJob({
          type: "room_change_notify",
          payload: { roomId: room.roomId },
          idempotencyKey: `room-change-notify:${room.roomId}:${room.version}`,
          partitionKey: `room:${room.roomId}`
        });
        const matchRequest = await this.store.getLatestMatchRequestForUser(userId);
        return {
          result: {
            room,
            matchRequest,
            canRematch: false,
            interestState: matchRequest?.status === "matching" ? matchRequest.phase : "ended",
            jobId: notifyJob.id
          },
          matchRequest,
          room: null
        };
      }
      case "confirm_room": {
        if (!currentRoom) throw new StoreNotFoundError("当前没有可以确认的房间");
        const room = await this.store.confirmRoom(currentRoom.roomId, userId);
        return { result: { room }, matchRequest: currentMatchRequest, room };
      }
      case "complete_room": {
        if (!currentRoom) throw new StoreNotFoundError("当前没有可以完成的房间");
        const room = await this.store.completeRoom(currentRoom.roomId);
        return { result: { room }, matchRequest: currentMatchRequest, room };
      }
      case "submit_feedback": {
        if (!currentRoom) throw new StoreNotFoundError("当前没有可以反馈的房间");
        const feedback = postEventFeedbackSchema.parse({
          userId,
          roomId: currentRoom.roomId,
          peopleFeedback: action.peopleFeedback,
          gameFeedback: action.gameFeedback,
          connectionUserIds: action.connectionUserIds,
          nextIntent: action.nextIntent
        });
        const feedbackId = await this.store.saveFeedback(feedback);
        const feedbackJob = await this.store.enqueueJob({
          type: "feedback_update",
          payload: { feedback, feedbackId },
          idempotencyKey: `feedback:${feedbackId}`,
          partitionKey: `user:${userId}`
        });
        return {
          result: { feedbackId, jobId: feedbackJob.id },
          matchRequest: currentMatchRequest,
          room: currentRoom
        };
      }
    }
  }

  private async processMultimodal(job: LlmJob): Promise<Record<string, unknown>> {
    const userId = requireString(job.payload, "userId");
    const inputId = requireString(job.payload, "inputId");
    const kind = requireString(job.payload, "kind");
    if (kind !== "image" && kind !== "audio") throw new Error("多模态类型无效");
    const [storagePath, onboardingState] = await Promise.all([
      this.store.resolveStorageUrl(requireString(job.payload, "storagePath")),
      this.store.ensureAdventurexOnboardingState(userId)
    ]);
    const understanding = await this.agent.understandMultimodal({
      kind,
      storagePath,
      mimeType: requireString(job.payload, "mimeType"),
      hint: typeof job.payload.hint === "string" ? job.payload.hint : undefined,
      preferredLanguage: onboardingState.preferredLanguage
    });
    await this.store.updateMultimodalInput(inputId, understanding);
    await this.store.updateAdventurexOnboardingState(userId, { stage: "exploring" });
    const userModel = await this.saveModelWithRetry(userId, (current) =>
      applyMultimodalInsight(current, inputId, understanding)
    );
    const reply = typeof understanding.reply === "string" ? understanding.reply : null;
    if (!reply) throw new Error("多模态理解没有返回可发布回复");
    const message = await this.store.appendMessage({
      userId,
      role: "assistant",
      content: reply,
      idempotencyKey: `multimodal-reply:${job.id}`
    });
    const memoryContent = typeof understanding.recentImpression === "string"
      ? understanding.recentImpression
      : typeof understanding.summary === "string"
        ? understanding.summary
        : "";
    const memoryJob = memoryContent
      ? await this.store.enqueueJob({
          type: "memory_extract",
          payload: {
            userId,
            sourceType: "multimodal",
            sourceId: inputId,
            content: memoryContent,
            assistantReply: reply
          },
          idempotencyKey: `memory:multimodal:${inputId}`,
          partitionKey: `user:${userId}`
        })
      : null;
    return { inputId, understanding, userModel, message, memoryJobId: memoryJob?.id ?? null };
  }

  private async processMatchmaking(job: LlmJob): Promise<Record<string, unknown>> {
    const requiredRequestId = requireString(job.payload, "requestId");
    const [candidates, games] = await Promise.all([
      this.store.listMatchCandidates(50),
      this.store.listOfflineGames()
    ]);
    const decision = await this.matchmaking.decide(candidates, games, requiredRequestId);
    if (!decision) return { matched: false, waitingCount: candidates.length };
    const waitingRequests = candidates.map((candidate) => candidate.request) as MatchRequest[];
    const game = games.find((item) => item.id === decision.offlineGameId);
    validateMatchDecision(decision, waitingRequests, game, requiredRequestId);
    const roomId = await this.store.createRoomFromDecision(decision, job.id);
    const room = await this.store.getRoom(roomId);
    if (!room) throw new StoreNotFoundError("匹配房间创建后无法读取");
    await Promise.all(room.members.map(async (member) => {
      const composed = await this.composeProductMessage(member.userId, {
        kind: "legacy_match_ready",
        facts: {
          activity: room.offlineGame,
          memberCount: room.members.length,
          memberNames: room.members.map((item) => item.displayName),
          matchSummary: room.matchSummary,
          requiresConfirmation: true
        }
      });
      await this.appendProactiveMessage({
        userId: member.userId,
        content: composed.content,
        idempotencyKey: `room-ready:${roomId}:${member.userId}`
      });
    }));
    return { matched: true, roomId, decision, room };
  }

  private async buildRoomCandidates(room: MatchRoom): Promise<MatchCandidate[]> {
    return Promise.all(room.members
      .filter((member) => member.participationStatus === "confirmed")
      .map(async (member) => {
        const [userModel, latestRequest, socialHooks] = await Promise.all([
          this.store.getUserModel(member.userId),
          this.store.getLatestMatchRequestForUser(member.userId),
          this.store.listActiveSocialHooks(member.userId, 12)
        ]);
        return {
          request: latestRequest ?? {
            requestId: `room:${room.roomId}:${member.userId}`,
            userId: member.userId,
            intentSnapshot: {},
            status: "matched" as const,
            proactivePushEnabled: false,
            roomId: room.roomId,
            createdAt: room.createdAt,
            updatedAt: room.createdAt
          },
          userModel,
          matchingNarrative: userModel.vibeNarrative,
          socialHooks
        };
      }));
  }

  private async composeRoomIntro(room: MatchRoom, userId: string): Promise<string> {
    const confirmedMembers = room.members.filter((member) => member.participationStatus === "confirmed");
    const hooks = (await Promise.all(confirmedMembers
      .filter((member) => member.userId !== userId)
      .map((member) => this.store.listActiveSocialHooks(member.userId, 3))))
      .flat()
      .filter((hook, index, all) => all.findIndex((item) => item.userId === hook.userId) === index)
      .slice(0, 3);
    const composed = await this.composeProductMessage(userId, {
      kind: "room_intro",
      facts: {
        activity: room.offlineGame,
        playerCount: confirmedMembers.length,
        meetingPoint: room.meetingPoint,
        confirmedFacts: hooks.map((hook) => ({ hookText: hook.hookText }))
      }
    });
    await this.store.saveRoomIntro(room.roomId, userId, composed.content, hooks.map((hook) => hook.id));
    return composed.content;
  }

  private async processMatchRoundGenerate(job: LlmJob): Promise<Record<string, unknown>> {
    const roundId = requireString(job.payload, "roundId");
    const existingState = await this.store.getRoundSettlementState(roundId);
    if (existingState.round.status === "collecting" && existingState.round.offerExpiresAt) {
      let offerCount = 0;
      for (const request of existingState.requests.filter((item) =>
        item.status === "matching"
        && item.activeRoundId === roundId
        && ["offered", "selected"].includes(item.phase)
      )) {
        const options = await this.store.listCurrentMatchOptions(request.userId);
        if (!options || options.roundId !== roundId) continue;
        offerCount += options.options.length;
        const optionNumbers = options.options
          .map((option) => option.optionNumber)
          .filter((number): number is 1 | 2 | 3 => number === 1 || number === 2 || number === 3);
        if (request.intentSnapshot.virtualTestUser === true) {
          if (request.phase !== "selected" && optionNumbers.length > 0) {
            await this.store.saveMatchChoices(request.requestId, {
              preferredOptionNumber: optionNumbers[0] ?? null,
              acceptedOptionNumbers: optionNumbers,
              requiredHookIds: [],
              rawText: "virtual-test-harness-auto-accept"
            });
          }
          continue;
        }
        const composed = await this.composeProductMessage(request.userId, {
          kind: "match_options",
          facts: {
            expiresAt: existingState.round.offerExpiresAt,
            options: options.options.map((option) => ({
              optionNumber: option.optionNumber,
              sourceType: option.sourceType,
              activityName: option.activityName,
              activityDescription: option.activityDescription,
              confirmedFacts: option.hooks
                .filter((hook) => hook.certainty === "confirmed")
                .map((hook) => ({ hookText: hook.hookText })),
              possibleFacts: option.hooks
                .filter((hook) => hook.certainty === "possible")
                .map((hook) => ({ hookText: hook.hookText }))
            }))
          }
        });
        await this.appendProactiveMessage({
          userId: request.userId,
          content: composed.content,
          idempotencyKey: `match-options:${roundId}:${request.requestId}`
        });
      }
      const settleJob = await this.store.enqueueJob({
        type: "match_round_settle",
        payload: { roundId },
        idempotencyKey: `match-round-settle:${roundId}`,
        partitionKey: `match-round:${roundId}`,
        runAt: existingState.round.offerExpiresAt
      });
      return {
        roundId,
        resumed: true,
        candidateCount: existingState.requests.length,
        draftCount: existingState.drafts.length,
        offerCount,
        settleJobId: settleJob.id
      };
    }
    if (["settling", "completed", "expired"].includes(existingState.round.status)) {
      return {
        roundId,
        resumed: true,
        candidateCount: existingState.requests.length,
        draftCount: existingState.drafts.length,
        offerCount: 0,
        settleJobId: null
      };
    }
    const [candidates, games] = await Promise.all([
      this.store.listRoundCandidates(roundId),
      this.store.listOfflineGames()
    ]);
    const candidateByRequest = new Map(candidates.map((candidate) => [candidate.request.requestId, candidate]));
    const activeEntrants = candidates.filter((candidate) =>
      candidate.request.status === "matching"
      && candidate.request.phase === "waiting"
      && candidate.request.activeRoundId === roundId
    );
    const preparedOffers: import("@tomeet/data").PreparedMatchOffer[] = [];
    const presentationFacts = new Map<string, Record<string, unknown>>();
    const nextOptionNumber = new Map<string, number>();

    for (const candidate of candidates) {
      const rooms = await this.store.listSuitableOpenRooms(candidate.request.userId, 3);
      for (const room of rooms) {
        const roomCandidates = await this.buildRoomCandidates(room);
        const judgement = await this.matchmaking.judgeGroup([...roomCandidates, candidate], room.offlineGame);
        if (judgement.verdict !== "good" && judgement.verdict !== "excellent") continue;
        const confirmedHooks = roomCandidates
          .flatMap((item) => item.socialHooks ?? [])
          .filter((hook) => hook.userId !== candidate.request.userId)
          .filter((hook, index, hooks) => hooks.findIndex((item) => item.userId === hook.userId) === index)
          .slice(0, 3);
        const optionNumber = (nextOptionNumber.get(candidate.request.requestId) ?? 0) + 1;
        if (optionNumber > 3) break;
        const confirmedCount = room.members.filter((member) => member.participationStatus === "confirmed").length;
        const capacity = Math.min(room.targetPlayers ?? room.offlineGame.maxPlayers, room.offlineGame.maxPlayers);
        const preparedOffer: import("@tomeet/data").PreparedMatchOffer = {
          requestId: candidate.request.requestId,
          sourceType: "open_room",
          roomId: room.roomId,
          sourceVersion: room.version,
          optionNumber: optionNumber as 1 | 2 | 3,
          offlineGameId: room.offlineGame.id,
          previewText: "",
          hooks: confirmedHooks.map((hook) => ({
            hookId: hook.id,
            hookText: hook.hookText,
            sourceUserId: hook.userId,
            certainty: "confirmed" as const
          }))
        };
        preparedOffers.push(preparedOffer);
        presentationFacts.set(`${preparedOffer.requestId}:${preparedOffer.optionNumber}`, {
          optionNumber,
          sourceType: "open_room",
          activityName: room.offlineGame.name,
          activityDescription: room.offlineGame.description,
          confirmedCount,
          remainingSeats: capacity - confirmedCount,
          confirmedFacts: confirmedHooks.map((hook) => ({ hookText: hook.hookText })),
          possibleFacts: []
        });
        nextOptionNumber.set(candidate.request.requestId, optionNumber);
        break;
      }
    }

    const proposed = await this.matchmaking.proposeMatchRound(candidates, games);
    const validatedProposal = proposed ? validateMatchRoundProposal(proposed, candidates, games) : null;
    const qualityRank = { good: 1, excellent: 2 } as const;
    const qualifiedDrafts: Array<{
      draft: MatchRoundProposal["drafts"][number];
      quality: keyof typeof qualityRank;
      activeWaitingCount: number;
    }> = [];
    for (const draft of validatedProposal?.drafts ?? []) {
      const game = games.find((item) => item.id === draft.offlineGameId);
      if (!game) continue;
      const members = draft.candidateRequestIds
        .map((requestId) => candidateByRequest.get(requestId))
        .filter((candidate): candidate is MatchCandidate => Boolean(candidate));
      if (members.length !== draft.candidateRequestIds.length) continue;
      const judgement = await this.matchmaking.judgeGroup(members, game);
      if (judgement.verdict !== "good" && judgement.verdict !== "excellent") continue;
      qualifiedDrafts.push({
        draft,
        quality: judgement.verdict,
        activeWaitingCount: members.filter((candidate) =>
          candidate.request.phase === "waiting" && candidate.request.activeRoundId === roundId
        ).length
      });
    }
    qualifiedDrafts.sort((left, right) =>
      right.activeWaitingCount - left.activeWaitingCount
      || qualityRank[right.quality] - qualityRank[left.quality]
    );

    const selectedDrafts: MatchRoundProposal["drafts"] = [];
    const selectedDraftIdsByRequest = new Map<string, string[]>();
    for (const { draft } of qualifiedDrafts) {
      const everyMemberHasCapacity = draft.candidateRequestIds.every((requestId) =>
        (nextOptionNumber.get(requestId) ?? 0) + (selectedDraftIdsByRequest.get(requestId)?.length ?? 0) < 3
      );
      if (!everyMemberHasCapacity) continue;
      selectedDrafts.push(draft);
      for (const requestId of draft.candidateRequestIds) {
        const current = selectedDraftIdsByRequest.get(requestId) ?? [];
        current.push(draft.tempDraftId);
        selectedDraftIdsByRequest.set(requestId, current);
      }
    }
    const proposal: MatchRoundProposal | null = selectedDrafts.length > 0
      ? {
          drafts: selectedDrafts,
          userOptions: [...selectedDraftIdsByRequest].map(([requestId, tempDraftIds]) => ({
            requestId,
            tempDraftIds
          }))
        }
      : null;
    const draftByTemp = new Map(proposal?.drafts.map((draft) => [draft.tempDraftId, draft]) ?? []);
    for (const userOption of proposal?.userOptions ?? []) {
      for (const tempDraftId of userOption.tempDraftIds) {
        const optionNumber = (nextOptionNumber.get(userOption.requestId) ?? 0) + 1;
        if (optionNumber > 3) break;
        const draft = draftByTemp.get(tempDraftId);
        if (!draft) continue;
        const game = games.find((item) => item.id === draft.offlineGameId);
        if (!game) continue;
        const viewer = candidateByRequest.get(userOption.requestId);
        if (!viewer) continue;
        const possibleHooks = draft.candidateRequestIds
          .filter((requestId) => requestId !== userOption.requestId)
          .flatMap((requestId) => candidateByRequest.get(requestId)?.socialHooks ?? [])
          .filter((hook) => hook.userId !== viewer.request.userId)
          .filter((hook, index, hooks) => hooks.findIndex((item) => item.userId === hook.userId) === index)
          .slice(0, 3);
        const preparedOffer: import("@tomeet/data").PreparedMatchOffer = {
          requestId: userOption.requestId,
          sourceType: "draft",
          tempDraftId,
          sourceVersion: 0,
          optionNumber: optionNumber as 1 | 2 | 3,
          offlineGameId: game.id,
          previewText: "",
          hooks: possibleHooks.map((hook) => ({
            hookId: hook.id,
            hookText: hook.hookText,
            sourceUserId: hook.userId,
            certainty: "possible" as const
          }))
        };
        preparedOffers.push(preparedOffer);
        presentationFacts.set(`${preparedOffer.requestId}:${preparedOffer.optionNumber}`, {
          optionNumber,
          sourceType: "draft",
          activityName: game.name,
          activityDescription: game.description,
          confirmedFacts: [],
          possibleFacts: possibleHooks.map((hook) => ({ hookText: hook.hookText }))
        });
        nextOptionNumber.set(userOption.requestId, optionNumber);
      }
    }

    const offeredRequestIds = new Set(preparedOffers.map((offer) => offer.requestId));
    for (const requestId of offeredRequestIds) {
      const candidate = candidateByRequest.get(requestId);
      if (!candidate || candidate.request.activeRoundId === roundId) continue;
      await this.store.addRequestToRound(roundId, requestId);
    }

    const unavailableCause = games.length === 0
      ? "no_activity"
      : candidates.length < Math.min(...games.map((game) => game.minPlayers))
        ? "insufficient_pool"
        : "low_fit";
    const noOfferEntrants = activeEntrants.filter((candidate) => !offeredRequestIds.has(candidate.request.requestId));
    for (const candidate of noOfferEntrants) {
      await this.store.setMatchRequestInterest(candidate.request.requestId, {
        phase: candidate.request.proactivePushEnabled ? "watching" : "push_consent",
        proactivePushEnabled: candidate.request.proactivePushEnabled,
        clearRound: true
      });
    }

    const notifyUnavailable = async (
      entrants: MatchCandidate[],
      cause: string,
      idempotencySuffix: string
    ) => {
      await Promise.all(entrants
        .filter((candidate) => candidate.request.intentSnapshot.virtualTestUser !== true)
        .map(async (candidate) => {
          const latest = await this.store.getMatchRequest(candidate.request.requestId);
          if (!latest || latest.status !== "matching") return;
          await this.appendProactiveProductMessage({
            userId: candidate.request.userId,
            event: {
              kind: "match_unavailable",
              facts: {
                cause,
                availablePeopleCount: Math.max(0, candidates.length - 1),
                canEnableProactivePush: !latest.proactivePushEnabled,
                proactivePushAlreadyEnabled: latest.proactivePushEnabled,
                currentInterestState: latest.phase
              }
            },
            idempotencyKey: `match-unavailable:${roundId}:${candidate.request.requestId}:${idempotencySuffix}`
          });
        }));
    };

    if (preparedOffers.length === 0) {
      await this.store.settleMatchRound(roundId, []);
      await notifyUnavailable(activeEntrants, unavailableCause, "empty");
      return {
        roundId,
        candidateCount: candidates.length,
        draftCount: 0,
        offerCount: 0,
        unavailableCount: activeEntrants.length,
        settleJobId: null
      };
    }

    const preparedByRequest = new Map<string, typeof preparedOffers>();
    for (const offer of preparedOffers) {
      const group = preparedByRequest.get(offer.requestId) ?? [];
      group.push(offer);
      preparedByRequest.set(offer.requestId, group);
    }
    const optionMessages = new Map<string, string>();
    await Promise.all([...preparedByRequest].map(async ([requestId, requestOffers]) => {
      const candidate = candidateByRequest.get(requestId);
      if (!candidate) return;
      if (candidate.request.intentSnapshot.virtualTestUser === true) {
        const previews = requestOffers
          .sort((left, right) => left.optionNumber - right.optionNumber)
          .map((offer) => {
            const game = games.find((item) => item.id === offer.offlineGameId);
            if (!game) throw new Error("测试候选引用了不存在的活动");
            const facts = presentationFacts.get(`${requestId}:${offer.optionNumber}`) ?? {};
            const preview = formatCandidatePreview({
              optionNumber: offer.optionNumber,
              game,
              confirmedHooks: offer.hooks.filter((hook) => hook.certainty === "confirmed").map((hook) => hook.hookText),
              possibleHooks: offer.hooks.filter((hook) => hook.certainty === "possible").map((hook) => hook.hookText),
              confirmedCount: typeof facts.confirmedCount === "number" ? facts.confirmedCount : undefined,
              remainingSeats: typeof facts.remainingSeats === "number" ? facts.remainingSeats : undefined
            });
            offer.previewText = preview;
            return preview;
          });
        optionMessages.set(requestId, previews.join("\n\n"));
        return;
      }
      const composed = await this.composeProductMessage(candidate.request.userId, {
        kind: "match_options",
        facts: {
          offerWindowSeconds: this.options.offerWindowSeconds ?? 90,
          options: requestOffers
            .sort((left, right) => left.optionNumber - right.optionNumber)
            .map((offer) => presentationFacts.get(`${requestId}:${offer.optionNumber}`))
            .filter(Boolean)
        }
      });
      const previewByNumber = new Map(composed.optionPreviews.map((preview) => [preview.optionNumber, preview.text]));
      for (const offer of requestOffers) {
        const preview = previewByNumber.get(offer.optionNumber);
        if (!preview) throw new Error(`候选 ${offer.optionNumber} 缺少个性化文案`);
        offer.previewText = preview;
      }
      optionMessages.set(requestId, composed.content);
    }));
    const offerExpiresAt = new Date(Date.now() + (this.options.offerWindowSeconds ?? 90) * 1_000).toISOString();
    const offers = await this.store.saveRoundProposals({
      roundId,
      proposal,
      offers: preparedOffers,
      offerExpiresAt
    });
    if (offers.length === 0) {
      const stillActive = activeEntrants.filter((candidate) => !noOfferEntrants.some(
        (item) => item.request.requestId === candidate.request.requestId
      ));
      for (const candidate of stillActive) {
        const latest = await this.store.getMatchRequest(candidate.request.requestId);
        if (!latest || latest.status !== "matching" || latest.activeRoundId !== roundId) continue;
        await this.store.setMatchRequestInterest(candidate.request.requestId, {
          phase: latest.proactivePushEnabled ? "watching" : "push_consent",
          proactivePushEnabled: latest.proactivePushEnabled,
          clearRound: true
        });
      }
      await this.store.settleMatchRound(roundId, []);
      await notifyUnavailable(activeEntrants, unavailableCause, "save-race");
      return {
        roundId,
        candidateCount: candidates.length,
        draftCount: 0,
        offerCount: 0,
        unavailableCount: activeEntrants.length,
        settleJobId: null
      };
    }
    const offersByRequest = new Map<string, typeof offers>();
    for (const offer of offers) {
      const group = offersByRequest.get(offer.requestId) ?? [];
      group.push(offer);
      offersByRequest.set(offer.requestId, group);
    }
    await Promise.all([...offersByRequest].map(async ([requestId]) => {
      const candidate = candidateByRequest.get(requestId);
      if (!candidate) return;
      const content = optionMessages.get(requestId);
      if (!content) throw new Error("候选消息没有完成个性化生成");
      if (candidate.request.intentSnapshot.virtualTestUser === true) {
        const requestOffers = offersByRequest.get(requestId) ?? [];
        const optionNumbers = requestOffers
          .map((offer) => offer.optionNumber)
          .filter((number): number is 1 | 2 | 3 => number === 1 || number === 2 || number === 3);
        if (optionNumbers.length > 0) {
          await this.store.saveMatchChoices(requestId, {
            preferredOptionNumber: optionNumbers[0] ?? null,
            acceptedOptionNumbers: optionNumbers,
            requiredHookIds: [],
            rawText: "virtual-test-harness-auto-accept"
          });
        }
        return;
      }
      await this.appendProactiveMessage({
        userId: candidate.request.userId,
        content,
        idempotencyKey: `match-options:${roundId}:${requestId}`
      });
    }));
    await notifyUnavailable(noOfferEntrants, unavailableCause, "partial");
    const settleJob = await this.store.enqueueJob({
      type: "match_round_settle",
      payload: { roundId },
      idempotencyKey: `match-round-settle:${roundId}`,
      partitionKey: `match-round:${roundId}`,
      runAt: offerExpiresAt
    });
    return {
      roundId,
      candidateCount: candidates.length,
      draftCount: proposal?.drafts.length ?? 0,
      offerCount: offers.length,
      unavailableCount: noOfferEntrants.length,
      settleJobId: settleJob.id
    };
  }

  private async processMatchRoundSettle(job: LlmJob): Promise<Record<string, unknown>> {
    const roundId = requireString(job.payload, "roundId");
    const [state, games] = await Promise.all([
      this.store.getRoundSettlementState(roundId),
      this.store.listOfflineGames()
    ]);
    const candidateByRequest = new Map<string, MatchCandidate>();
    await Promise.all(state.requests.map(async (request) => {
      const [userModel, socialHooks, profile] = await Promise.all([
        this.store.getUserModel(request.userId),
        this.store.listActiveSocialHooks(request.userId, 12),
        this.store.getMemoryProfile(request.userId)
      ]);
      candidateByRequest.set(request.requestId, {
        request,
        userModel,
        matchingNarrative: profile.stale ? userModel.vibeNarrative : profile.matchingNarrative || userModel.vibeNarrative,
        socialHooks
      });
    }));
    const hookSources = new Map(state.hooks.map((hook) => [hook.id, hook.userId]));
    const generated = generateFinalGroupCandidates({
      drafts: state.drafts,
      choices: state.choices,
      requests: state.requests,
      games,
      hookSourceUserById: hookSources
    });
    const judged = [];
    for (const candidate of generated.slice(0, 80)) {
      const game = games.find((item) => item.id === candidate.decision.offlineGameId);
      if (!game) continue;
      const members = candidate.decision.requestIds.map((requestId) => candidateByRequest.get(requestId)).filter(Boolean) as MatchCandidate[];
      const judgement = await this.matchmaking.judgeGroup(members, game);
      if (judgement.verdict !== "good" && judgement.verdict !== "excellent") continue;
      candidate.utility += MATCH_UTILITY_WEIGHTS.activity[judgement.verdict];
      judged.push(candidate);
    }
    const selected = selectNonOverlappingGroups(judged);
    const decisions: FinalRoomDecision[] = selected.map((candidate) => candidate.decision);
    const roomIds = await this.store.settleMatchRound(roundId, decisions);
    const matchedRequestIds = new Set(decisions.flatMap((decision) => decision.requestIds));
    for (const roomId of roomIds) {
      const room = await this.store.getRoom(roomId);
      if (!room) continue;
      await Promise.all(room.members
        .filter((member) => member.participationStatus === "confirmed")
        .map(async (member) => {
          const request = await this.store.getLatestMatchRequestForUser(member.userId);
          if (request?.intentSnapshot.virtualTestUser === true) return;
          const intro = await this.composeRoomIntro(room, member.userId);
          await this.appendProactiveMessage({
            userId: member.userId,
            content: intro,
            idempotencyKey: `room-intro:${roomId}:${member.userId}`
          });
        }));
    }
    const unresolvedRequests = state.requests.filter((item) => {
      const expiresInThisRun = item.status === "matching" && item.activeRoundId === roundId;
      const expiredByThisRound = item.status === "expired" && item.updatedAt <= state.round.updatedAt;
      return (expiresInThisRun || expiredByThisRound) && !matchedRequestIds.has(item.requestId);
    });
    let expiredRequestCount = 0;
    let watchingRequestCount = 0;
    for (const request of unresolvedRequests) {
      if (request.intentSnapshot.virtualTestUser === true) continue;
      const requestChoices = state.choices.filter((choice) => choice.requestId === request.requestId);
      const requiredChoice = requestChoices.find((choice) => choice.requiredHookIds.length > 0);
      const latest = await this.store.getMatchRequest(request.requestId);
      if (requestChoices.length > 0 && latest?.status === "matching"
        && (latest.phase === "push_consent" || latest.phase === "watching")) {
        await this.appendProactiveProductMessage({
          userId: request.userId,
          event: {
            kind: "match_confirmation_incomplete",
            facts: {
              cause: "candidate_not_formed",
              selectionRecorded: true,
              currentAttemptEnded: true,
              doNotIdentifyOtherUsers: true,
              canEnableProactivePush: latest.phase === "push_consent",
              proactivePushAlreadyEnabled: latest.proactivePushEnabled,
              currentInterestState: latest.phase,
              followUpPriority: "confirmation_follow_up"
            }
          },
          idempotencyKey: `match-confirmation-incomplete:${roundId}:${request.requestId}`
        });
        if (latest.phase === "watching") watchingRequestCount += 1;
        continue;
      }
      if (latest?.status === "matching" && latest.phase === "watching" && latest.proactivePushEnabled) {
        await this.appendProactiveProductMessage({
          userId: request.userId,
          event: {
            kind: "match_unavailable",
            facts: {
              cause: "attempt_not_formed",
              hadSelection: requestChoices.length > 0,
              proactivePushAlreadyEnabled: true,
              canEnableProactivePush: false,
              currentInterestState: "watching"
            }
          },
          idempotencyKey: `match-unavailable:${roundId}:${request.requestId}:settled`
        });
        watchingRequestCount += 1;
        continue;
      }
      if (latest?.status !== "expired") continue;
      const reason = requiredChoice
        ? "required_fact_unavailable"
        : requestChoices.length > 0
          ? "selected_but_not_formed"
          : request.phase === "offered" ? "selection_timeout" : "no_candidates";
      await this.appendProactiveProductMessage({
        userId: request.userId,
        event: {
          kind: "match_expired",
          facts: {
            reason,
            requiredFact: requiredChoice
              ? state.hooks.find((hook) => requiredChoice.requiredHookIds.includes(hook.id))?.hookText ?? null
              : null,
            canRematch: true,
            rematchRequiresExplicitUserRequest: true
          }
        },
        idempotencyKey: `match-expired:${roundId}:${request.requestId}`
      });
      await this.store.updateAdventurexOnboardingState(request.userId, { stage: "ready" });
      expiredRequestCount += 1;
    }
    return {
      roundId,
      candidateGroupCount: generated.length,
      selectedGroupCount: selected.length,
      expiredRequestCount,
      watchingRequestCount,
      roomIds
    };
  }

  private async processRoomChangeNotify(): Promise<Record<string, unknown>> {
    const [roomNotifications, draftNotifications] = await Promise.all([
      this.store.listPendingRoomChangeNotifications(200),
      this.store.listPendingDraftChangeNotifications(200)
    ]);
    for (const notification of roomNotifications) {
      const request = await this.store.getLatestMatchRequestForUser(notification.userId);
      if (request?.intentSnapshot.virtualTestUser === true) {
        await this.store.markRoomChangeNotificationDelivered(notification.eventId, notification.userId);
        continue;
      }
      const room = await this.store.getRoom(notification.roomId);
      const confirmedCount = room?.members.filter(
        (member) => member.participationStatus === "confirmed"
      ).length ?? 0;
      const meetsMinimumPlayers = room ? confirmedCount >= room.offlineGame.minPlayers : false;
      const updatedIntro = room?.members.some((member) =>
        member.userId === notification.userId && member.participationStatus === "confirmed"
      ) && meetsMinimumPlayers ? await this.composeRoomIntro(room, notification.userId) : null;
      const composed = await this.composeProductMessage(notification.userId, {
        kind: "room_change",
        facts: {
          changeType: notification.changeType,
          change: notification.payload,
          room: room ? {
            activity: room.offlineGame,
            memberCount: confirmedCount,
            minimumPlayers: room.offlineGame.minPlayers,
            currentlyFormed: meetsMinimumPlayers,
            recruitmentStatus: room.recruitmentStatus,
            meetingPoint: room.meetingPoint
          } : null,
          updatedIntro,
          canRematch: notification.changeType === "room_cancelled"
        }
      });
      await this.appendProactiveMessage({
        userId: notification.userId,
        content: composed.content,
        idempotencyKey: notification.idempotencyKey
      });
      await this.store.markRoomChangeNotificationDelivered(notification.eventId, notification.userId);
    }
    for (const notification of draftNotifications) {
      const request = await this.store.getLatestMatchRequestForUser(notification.userId);
      if (request?.intentSnapshot.virtualTestUser === true) {
        await this.store.markDraftChangeNotificationDelivered(notification.eventId, notification.userId);
        continue;
      }
      const composed = await this.composeProductMessage(notification.userId, {
        kind: "draft_change",
        facts: {
          changeType: notification.changeType,
          change: notification.payload
        }
      });
      await this.appendProactiveMessage({
        userId: notification.userId,
        content: composed.content,
        idempotencyKey: notification.idempotencyKey
      });
      await this.store.markDraftChangeNotificationDelivered(notification.eventId, notification.userId);
    }
    const reopenedRoomEventCount = new Set(roomNotifications
      .filter((notification) => notification.changeType === "member_withdrawn")
      .map((notification) => notification.eventId)).size;
    const recallJob = this.adventurexMatchingV1 && reopenedRoomEventCount > 0
      ? await scheduleAdventurexClearingTick(this.store, {
          roundBucketSeconds: this.options.roundBucketSeconds
        })
      : null;
    return {
      roomNotificationCount: roomNotifications.length,
      draftNotificationCount: draftNotifications.length,
      reopenedRoomEventCount,
      recallJobId: recallJob?.job.id ?? null
    };
  }

  private async processFeedback(job: LlmJob): Promise<Record<string, unknown>> {
    const feedback = postEventFeedbackSchema.parse(job.payload.feedback);
    const current = await this.store.getUserModel(feedback.userId);
    const insight = await this.agent.reflectOnFeedback(feedback, current);
    const userModel = await this.saveModelWithRetry(feedback.userId, (latest) =>
      updateModelFromFeedback(latest, feedback, insight)
    );
    const feedbackId = requireString(job.payload, "feedbackId");
    const memoryJob = await this.store.enqueueJob({
      type: "memory_extract",
      payload: {
        userId: feedback.userId,
        sourceType: "feedback",
        sourceId: feedbackId,
        content: JSON.stringify({
          peopleFeedback: feedback.peopleFeedback,
          gameFeedback: feedback.gameFeedback,
          nextIntent: feedback.nextIntent
        })
      },
      idempotencyKey: `memory:feedback:${feedbackId}`,
      partitionKey: `user:${feedback.userId}`
    });
    return { userModel, memoryJobId: memoryJob.id };
  }

  private async processMemoryExtract(job: LlmJob): Promise<Record<string, unknown>> {
    const userId = requireString(job.payload, "userId");
    const sourceType = userMemorySourceTypeSchema.parse(job.payload.sourceType);
    const sourceId = requireString(job.payload, "sourceId");
    const content = requireString(job.payload, "content");
    const activeMemories = await this.store.listActiveMemories(userId, 128);
    const extracted = await this.agent.extractMemories({
      userId,
      sourceType,
      sourceId,
      content,
      assistantReply: typeof job.payload.assistantReply === "string"
        ? job.payload.assistantReply
        : undefined,
      activeMemoryIndex: activeMemories
    });
    const allowedMemoryIds = new Set(activeMemories.map((memory) => memory.id));
    const forgetMemoryIds = [...new Set(extracted.forgetMemoryIds)]
      .filter((memoryId) => allowedMemoryIds.has(memoryId));
    const sanitized = sanitizeMemoryCandidates(extracted.candidates, sourceType);
    const applied = await this.store.applyMemoryChanges({
      userId,
      sourceType,
      sourceId,
      explicitness: sourceType === "message"
        ? "explicit"
        : sourceType === "feedback"
          ? "experienced"
          : "observed",
      candidates: extracted.forgetAll ? [] : sanitized.accepted,
      forgetMemoryIds,
      forgetAll: extracted.forgetAll
    });
    const changed = applied.memories.length > 0 || applied.forgottenCount > 0;
    const consolidationJob = changed
      ? await this.store.enqueueJob({
          type: "memory_consolidate",
          payload: { userId },
          idempotencyKey: `memory-profile:${job.id}`,
          partitionKey: `user:${userId}`
        })
      : null;
    return {
      noOutput: !changed,
      createdOrUpdatedCount: applied.memories.length,
      forgottenCount: applied.forgottenCount,
      rejectedSensitiveCount: extracted.rejectedSensitiveCount + sanitized.rejectedCount,
      consolidationJobId: consolidationJob?.id ?? null
    };
  }

  private async processMemoryConsolidate(job: LlmJob): Promise<Record<string, unknown>> {
    const userId = requireString(job.payload, "userId");
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [memories, profile] = await Promise.all([
        this.store.listActiveMemories(userId, 128),
        this.store.getMemoryProfile(userId)
      ]);
      const draft = await this.agent.consolidateMemoryProfile(memories, profile);
      const allowedMemoryIds = new Set(memories.map((memory) => memory.id));
      const sourceMemoryIds = [...new Set(draft.sourceMemoryIds)]
        .filter((memoryId) => allowedMemoryIds.has(memoryId))
        .slice(0, 128);
      const profileNarrative = truncateToEstimatedTokens(draft.profileNarrative, 1_200);
      const matchingNarrative = truncateToEstimatedTokens(draft.matchingNarrative, 1_000);
      if (
        containsSensitivePersonalData(profileNarrative)
        || containsSensitivePersonalData(matchingNarrative)
      ) {
        throw new Error("记忆画像包含不允许持久化的敏感信息");
      }
      const sourceWatermark = memories
        .map((memory) => memory.updatedAt)
        .sort()
        .at(-1) ?? null;
      const next: UserMemoryProfile = {
        ...profile,
        profileNarrative,
        matchingNarrative,
        sourceMemoryIds,
        sourceWatermark,
        version: profile.version + 1,
        stale: false,
        updatedAt: new Date().toISOString()
      };
      try {
        const saved = await this.store.saveMemoryProfile(next, profile.version);
        return {
          profileVersion: saved.version,
          sourceMemoryCount: saved.sourceMemoryIds.length
        };
      } catch (error) {
        lastError = error;
        if (!(error instanceof StoreConflictError)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("更新用户记忆画像冲突");
  }
}
