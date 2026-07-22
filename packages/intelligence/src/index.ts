import { buildAgentContext, type AgentAction, type AgentIntelligence } from "@tomeet/agent-core";
import { postEventFeedbackSchema, type LlmJob, type MatchRequest, type MatchRoom, type UserModel } from "@tomeet/contracts";
import type { DataStore } from "@tomeet/data";
import { StoreConflictError, StoreNotFoundError } from "@tomeet/data";
import { updateModelFromFeedback } from "@tomeet/feedback";
import { type MatchmakingIntelligence, validateMatchDecision } from "@tomeet/matchmaking";
import { applyConversationInsight, applyMultimodalInsight } from "@tomeet/user-model";

export * from "./hosted-llm.js";
export * from "./web-search.js";

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`任务缺少 ${key}`);
  return value;
}

export class JobProcessor {
  constructor(
    private readonly store: DataStore,
    private readonly agent: AgentIntelligence,
    private readonly matchmaking: MatchmakingIntelligence
  ) {}

  async process(job: LlmJob): Promise<Record<string, unknown>> {
    switch (job.type) {
      case "agent_reply":
        return this.processAgentReply(job);
      case "multimodal_understanding":
        return this.processMultimodal(job);
      case "matchmaking":
        return this.processMatchmaking(job);
      case "feedback_update":
        return this.processFeedback(job);
    }
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
    const [model, initialMatchRequest, initialRoom] = await Promise.all([
      this.store.getUserModel(userId),
      this.store.getLatestMatchRequestForUser(userId),
      this.store.getLatestRoomForUser(userId)
    ]);
    const [messages, rollingSummary] = await Promise.all([
      this.store.listRecentMessages(userId, 20),
      this.updateRollingSummary(userId)
    ]);
    const insight = await this.agent.reply(
      buildAgentContext(messages, model, {
        matchRequest: initialMatchRequest,
        room: initialRoom,
        rollingSummary
      }),
      userContent
    );
    const currentIntent = insight.currentIntent && insight.socialIntentDetected
      ? {
          ...insight.currentIntent,
          socialIntentConfirmed: true,
          confirmedAt: new Date().toISOString()
        }
      : insight.currentIntent;
    const updatedModel = await this.saveModelWithRetry(userId, (current) =>
      applyConversationInsight(current, {
        interests: insight.interests,
        vibeNarrative: insight.vibeNarrative,
        longTermProfilePatch: insight.longTermProfilePatch,
        currentIntent
      })
    );
    const actionResults: Array<Record<string, unknown>> = [];
    let matchRequest = initialMatchRequest;
    let room = initialRoom;
    for (const action of insight.actions) {
      try {
        const result = await this.executeAgentAction(job, userId, action, updatedModel, matchRequest, room);
        actionResults.push({ type: action.type, ok: true, ...result.result });
        matchRequest = result.matchRequest;
        room = result.room;
      } catch (error) {
        if (!(error instanceof StoreConflictError) && !(error instanceof StoreNotFoundError)) throw error;
        actionResults.push({ type: action.type, ok: false, error: error.message });
      }
    }
    const actionErrors = actionResults.filter((result) => result.ok === false).map((result) => result.error);
    const replyContent = actionErrors.length
      ? `${insight.reply}\n\n不过这次操作暂时没有完成：${actionErrors.join("；")}`
      : insight.reply;
    const message = await this.store.appendMessage({
      userId,
      role: "assistant",
      content: replyContent,
      idempotencyKey: `agent-reply:${job.id}`
    });
    return {
      message,
      userModel: updatedModel,
      socialIntentDetected: insight.socialIntentDetected,
      webSearch: insight.webSearch,
      actions: actionResults,
      matchRequest,
      room
    };
  }

  private async updateRollingSummary(userId: string): Promise<string> {
    let state = await this.store.getConversationState(userId);
    const messageCount = await this.store.countMessages(userId);
    const targetCount = Math.max(0, messageCount - 20);

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
        const matchmakingJob = await this.store.enqueueJob({
          type: "matchmaking",
          payload: { requestId: matchRequest.requestId },
          idempotencyKey: `match:${matchRequest.requestId}`
        });
        return {
          result: { matchRequest, jobId: matchmakingJob.id },
          matchRequest,
          room: currentRoom
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
          idempotencyKey: `feedback:${feedbackId}`
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
    const storagePath = await this.store.resolveStorageUrl(requireString(job.payload, "storagePath"));
    const understanding = await this.agent.understandMultimodal({
      kind,
      storagePath,
      mimeType: requireString(job.payload, "mimeType"),
      hint: typeof job.payload.hint === "string" ? job.payload.hint : undefined
    });
    await this.store.updateMultimodalInput(inputId, understanding);
    const userModel = await this.saveModelWithRetry(userId, (current) =>
      applyMultimodalInsight(current, inputId, understanding)
    );
    const reply = typeof understanding.reply === "string"
      ? understanding.reply
      : "我已经把这份视觉或声音材料融入了对你的理解。";
    const message = await this.store.appendMessage({
      userId,
      role: "assistant",
      content: reply,
      idempotencyKey: `multimodal-reply:${job.id}`
    });
    return { inputId, understanding, userModel, message };
  }

  private async processMatchmaking(job: LlmJob): Promise<Record<string, unknown>> {
    const requiredRequestId = requireString(job.payload, "requestId");
    const [candidates, games] = await Promise.all([
      this.store.listMatchCandidates(50),
      this.store.listOfflineGames()
    ]);
    const decision = await this.matchmaking.decide(candidates, games, requiredRequestId);
    if (!decision) return { matched: false, waitingCount: candidates.length };
    const waitingRequests = candidates.map((candidate) => candidate.request);
    const game = games.find((item) => item.id === decision.offlineGameId);
    validateMatchDecision(decision, waitingRequests, game, requiredRequestId);
    const roomId = await this.store.createRoomFromDecision(decision, job.id);
    const room = await this.store.getRoom(roomId);
    if (!room) throw new StoreNotFoundError("匹配房间创建后无法读取");
    const memberNames = room.members.map((member) => member.displayName).join("、");
    const notification = [
      `匹配完成了。这次是 ${room.members.length} 人小组：${memberNames}。`,
      `线下游戏是「${room.offlineGame.name}」：${room.offlineGame.description}`,
      `匹配考虑：${room.matchSummary}`,
      "如果你愿意参加，直接回复我“确认参加”。"
    ].join("\n\n");
    await Promise.all(room.members.map((member) => this.store.appendMessage({
      userId: member.userId,
      role: "assistant",
      content: notification,
      idempotencyKey: `room-ready:${roomId}:${member.userId}`
    })));
    return { matched: true, roomId, decision, room };
  }

  private async processFeedback(job: LlmJob): Promise<Record<string, unknown>> {
    const feedback = postEventFeedbackSchema.parse(job.payload.feedback);
    const current = await this.store.getUserModel(feedback.userId);
    const insight = await this.agent.reflectOnFeedback(feedback, current);
    const userModel = await this.saveModelWithRetry(feedback.userId, (latest) =>
      updateModelFromFeedback(latest, feedback, insight)
    );
    return { userModel };
  }
}
