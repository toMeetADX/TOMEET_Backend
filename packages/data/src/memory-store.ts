import { randomUUID } from "node:crypto";
import type {
  ChannelIdentity,
  ChannelProvider,
  LlmJob,
  MatchDecision,
  MatchRequest,
  MatchRoom,
  Message,
  OfflineGame,
  PostEventFeedback,
  UserMemory,
  UserMemoryProfile,
  UserModel
} from "@tomeet/contracts";
import { curatedGames } from "@tomeet/game-catalog";
import type { MatchCandidate } from "@tomeet/matchmaking";
import { validateMatchDecision } from "@tomeet/matchmaking";
import { createDefaultUserModel } from "@tomeet/user-model";
import type {
  ApplyMemoryChangesInput,
  ApplyMemoryChangesResult,
  DataStore,
  EnqueueJobInput,
  LinkChannelIdentityInput,
  MultimodalRecordInput
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

export class MemoryStore implements DataStore {
  private readonly users = new Map<string, MemoryUser>();
  private readonly messages: Message[] = [];
  private readonly matchRequests = new Map<string, MatchRequest>();
  private readonly rooms = new Map<string, MatchRoom>();
  private readonly jobs = new Map<string, LlmJob>();
  private readonly jobKeys = new Map<string, string>();
  private readonly multimodal = new Map<string, MultimodalRecordInput & { understanding?: Record<string, unknown> }>();
  private readonly uploadedFiles = new Map<string, { mimeType: string; bytes: Uint8Array }>();
  private readonly feedbackKeys = new Map<string, string>();
  private readonly sourceJobRooms = new Map<string, string>();
  private readonly userMemories = new Map<string, UserMemory>();
  private readonly memoryProfiles = new Map<string, UserMemoryProfile>();
  private readonly channelIdentities = new Map<string, ChannelIdentity>();

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
      this.memoryProfiles.set(userId, this.createMemoryProfile(userId));
      const now = new Date().toISOString();
      const requestId = randomUUID();
      this.matchRequests.set(requestId, {
        requestId,
        userId,
        intentSnapshot: model.currentIntent,
        status: "matching",
        roomId: null,
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
    } else if (displayName !== "新朋友") {
      this.users.get(userId)!.displayName = displayName;
    }
    if (!this.memoryProfiles.has(userId)) {
      this.memoryProfiles.set(userId, this.createMemoryProfile(userId));
    }
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
      createdAt: new Date().toISOString()
    };
    this.messages.push(message);
    return message;
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

  async createMatchRequest(userId: string, intentSnapshot: Record<string, unknown>): Promise<MatchRequest> {
    await this.ensureUser(userId);
    const activeRoom = [...this.rooms.values()].find(
      (room) => room.status !== "completed" && room.members.some((member) => member.userId === userId)
    );
    if (activeRoom) throw new StoreConflictError("你还有一个未结束的匹配房间");
    const existing = [...this.matchRequests.values()].find(
      (request) => request.userId === userId && request.status === "matching"
    );
    if (existing) return structuredClone(existing);
    const now = new Date().toISOString();
    const request: MatchRequest = {
      requestId: randomUUID(),
      userId,
      intentSnapshot: structuredClone(intentSnapshot),
      status: "matching",
      roomId: null,
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
    request.updatedAt = new Date().toISOString();
    return structuredClone(request);
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
          : this.memoryProfiles.get(request.userId)?.matchingNarrative ?? ""
    }));
  }

  async listOfflineGames(): Promise<OfflineGame[]> {
    return structuredClone(curatedGames);
  }

  async createRoomFromDecision(decision: MatchDecision, sourceJobId?: string): Promise<string> {
    if (sourceJobId && this.sourceJobRooms.has(sourceJobId)) return this.sourceJobRooms.get(sourceJobId)!;
    const requests = decision.requestIds.map((id) => this.matchRequests.get(id)).filter(Boolean) as MatchRequest[];
    const game = curatedGames.find((item) => item.id === decision.offlineGameId);
    validateMatchDecision(decision, requests, game);
    if (!game) throw new StoreNotFoundError("线下游戏不存在");

    const roomId = randomUUID();
    const now = new Date().toISOString();
    const members = decision.memberIds.map((userId) => ({
      userId,
      displayName: this.users.get(userId)?.displayName ?? "成员",
      confirmed: userId.startsWith("demo-")
    }));
    const room: MatchRoom = {
      roomId,
      members,
      offlineGame: structuredClone(game),
      matchSummary: decision.summary,
      status: members.every((member) => member.confirmed) ? "confirmed" : "confirming",
      createdAt: now,
      completedAt: null
    };
    this.rooms.set(roomId, room);
    if (sourceJobId) this.sourceJobRooms.set(sourceJobId, roomId);
    for (const request of requests) {
      request.status = "matched";
      request.roomId = roomId;
      request.updatedAt = now;
      const user = this.users.get(request.userId);
      if (user && !user.model.socialHistory.includes(roomId)) {
        user.model.socialHistory = [...user.model.socialHistory, roomId].slice(-50);
        user.model.version += 1;
        user.model.updatedAt = now;
      }
    }
    return roomId;
  }

  async getRoom(roomId: string): Promise<MatchRoom | null> {
    const room = this.rooms.get(roomId);
    return room ? structuredClone(room) : null;
  }

  async getLatestRoomForUser(userId: string): Promise<MatchRoom | null> {
    const room = [...this.rooms.values()]
      .filter((item) => item.members.some((member) => member.userId === userId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return room ? structuredClone(room) : null;
  }

  async confirmRoom(roomId: string, userId: string): Promise<MatchRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new StoreNotFoundError("房间不存在");
    if (room.status === "completed") throw new StoreConflictError("活动已完成");
    const member = room.members.find((item) => item.userId === userId);
    if (!member) throw new StoreConflictError("用户不在房间中");
    member.confirmed = true;
    if (room.members.every((item) => item.confirmed)) room.status = "confirmed";
    return structuredClone(room);
  }

  async completeRoom(roomId: string): Promise<MatchRoom> {
    const room = this.rooms.get(roomId);
    if (!room) throw new StoreNotFoundError("房间不存在");
    if (room.status === "completed") return structuredClone(room);
    if (!room.members.every((member) => member.confirmed)) throw new StoreConflictError("所有成员确认后才能完成活动");
    room.status = "completed";
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
        && (!item.partitionKey || !processingPartitions.has(item.partitionKey))
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
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
