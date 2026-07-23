import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  llmJobSchema,
  matchRequestSchema,
  matchRoomSchema,
  messageSchema,
  offlineGameSchema,
  userMemoryProfileSchema,
  userMemorySchema,
  userModelSchema,
  type LlmJob,
  type MatchDecision,
  type MatchRequest,
  type MatchRoom,
  type Message,
  type OfflineGame,
  type PostEventFeedback,
  type UserMemory,
  type UserMemoryProfile,
  type UserModel
} from "@tomeet/contracts";
import type { MatchCandidate } from "@tomeet/matchmaking";
import type {
  ApplyMemoryChangesInput,
  ApplyMemoryChangesResult,
  ConversationState,
  DataStore,
  EnqueueJobInput,
  MultimodalRecordInput
} from "./store.js";
import { StoreConflictError, StoreNotFoundError } from "./store.js";

type JsonRow = Record<string, unknown>;

function unwrapRpcData(data: unknown): unknown {
  if (Array.isArray(data) && data.length === 1) return data[0];
  return data;
}

function mapMessage(row: JsonRow): Message {
  return messageSchema.parse({
    id: row.id,
    userId: row.user_id ?? row.userId,
    role: row.role,
    content: row.content,
    createdAt: row.created_at ?? row.createdAt
  });
}

function mapUserModel(row: JsonRow): UserModel {
  return userModelSchema.parse({
    userId: row.user_id ?? row.userId,
    vibeNarrative: row.vibe_narrative ?? row.vibeNarrative ?? "",
    longTermProfile: row.long_term_profile ?? row.longTermProfile ?? {},
    currentIntent: row.current_intent ?? row.currentIntent ?? {},
    socialHistory: row.social_history ?? row.socialHistory ?? [],
    feedbackMemory: row.feedback_memory ?? row.feedbackMemory ?? [],
    multimodalUnderstanding: row.multimodal_understanding ?? row.multimodalUnderstanding ?? {},
    version: row.version ?? 0,
    updatedAt: row.updated_at ?? row.updatedAt
  });
}

function mapMatchRequest(row: JsonRow): MatchRequest {
  return matchRequestSchema.parse({
    requestId: row.id ?? row.request_id ?? row.requestId,
    userId: row.user_id ?? row.userId,
    intentSnapshot: row.intent_snapshot ?? row.intentSnapshot ?? {},
    status: row.status,
    roomId: row.room_id ?? row.roomId ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt
  });
}

function mapGame(row: JsonRow): OfflineGame {
  return offlineGameSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    minPlayers: row.min_players ?? row.minPlayers,
    maxPlayers: row.max_players ?? row.maxPlayers,
    intentTags: row.intent_tags ?? row.intentTags ?? [],
    traits: row.traits ?? [],
    requirements: row.requirements ?? [],
    instructions: row.instructions ?? []
  });
}

function mapJob(row: JsonRow): LlmJob {
  return llmJobSchema.parse({
    id: row.id,
    type: row.job_type ?? row.type,
    status: row.status,
    payload: row.payload ?? {},
    result: row.result ?? null,
    error: row.error ?? null,
    attempts: row.attempts ?? 0,
    maxAttempts: row.max_attempts ?? row.maxAttempts ?? 3,
    partitionKey: row.partition_key ?? row.partitionKey ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt
  });
}

function mapMemory(row: JsonRow): UserMemory {
  return userMemorySchema.parse({
    id: row.id,
    userId: row.user_id ?? row.userId,
    kind: row.memory_kind ?? row.kind,
    stableKey: row.stable_key ?? row.stableKey,
    content: row.content,
    sourceType: row.source_type ?? row.sourceType,
    sourceId: row.source_id ?? row.sourceId,
    explicitness: row.explicitness,
    status: row.status,
    supersededBy: row.superseded_by ?? row.supersededBy ?? null,
    confirmationCount: row.confirmation_count ?? row.confirmationCount ?? 1,
    usageCount: row.usage_count ?? row.usageCount ?? 0,
    lastConfirmedAt: row.last_confirmed_at ?? row.lastConfirmedAt,
    lastUsedAt: row.last_used_at ?? row.lastUsedAt ?? null,
    expiresAt: row.expires_at ?? row.expiresAt ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt
  });
}

function mapMemoryProfile(row: JsonRow): UserMemoryProfile {
  return userMemoryProfileSchema.parse({
    userId: row.user_id ?? row.userId,
    profileNarrative: row.profile_narrative ?? row.profileNarrative ?? "",
    matchingNarrative: row.matching_narrative ?? row.matchingNarrative ?? "",
    sourceMemoryIds: row.source_memory_ids ?? row.sourceMemoryIds ?? [],
    sourceWatermark: row.source_watermark ?? row.sourceWatermark ?? null,
    version: row.version ?? 0,
    stale: row.stale ?? false,
    updatedAt: row.updated_at ?? row.updatedAt
  });
}

export class SupabaseStore implements DataStore {
  readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-tomeet-service": "server" } }
    });
  }

  private throwError(context: string, error: { message: string; code?: string } | null): never {
    if (error?.code === "P0002") throw new StoreNotFoundError(error.message);
    if (error?.code === "23505" || error?.code === "P0001" || error?.code === "40001") {
      throw new StoreConflictError(error.message);
    }
    throw new Error(`${context}: ${error?.message ?? "Supabase 请求失败"}`);
  }

  async ensureUser(userId: string, displayName = "新朋友"): Promise<void> {
    const { error } = await this.client.rpc("ensure_tomeet_user", {
      p_user_id: userId,
      p_display_name: displayName
    });
    if (error) this.throwError("创建用户", error);
  }

  async appendMessage(input: {
    userId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
  }): Promise<Message> {
    const { data, error } = await this.client.rpc("append_agent_message", {
      p_user_id: input.userId,
      p_role: input.role,
      p_content: input.content,
      p_idempotency_key: input.idempotencyKey ?? null
    });
    if (error) this.throwError("写入消息", error);
    return mapMessage(unwrapRpcData(data) as JsonRow);
  }

  async listRecentMessages(userId: string, limit = 50): Promise<Message[]> {
    const { data, error } = await this.client
      .from("messages")
      .select("id,user_id,role,content,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(Math.min(limit, 100));
    if (error) this.throwError("读取消息", error);
    return (data ?? []).reverse().map((row) => mapMessage(row));
  }

  async listMessagesRange(userId: string, offset: number, limit: number): Promise<Message[]> {
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const { data, error } = await this.client
      .from("messages")
      .select("id,user_id,role,content,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(safeOffset, safeOffset + safeLimit - 1);
    if (error) this.throwError("读取待摘要消息", error);
    return (data ?? []).map((row) => mapMessage(row));
  }

  async countMessages(userId: string): Promise<number> {
    const { count, error } = await this.client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) this.throwError("统计对话消息", error);
    return count ?? 0;
  }

  async getConversationState(userId: string): Promise<ConversationState> {
    await this.ensureUser(userId);
    const { data, error } = await this.client
      .from("conversations")
      .select("rolling_summary,summarized_message_count")
      .eq("user_id", userId)
      .single();
    if (error) this.throwError("读取对话摘要", error);
    return {
      rollingSummary: String(data.rolling_summary ?? ""),
      summarizedMessageCount: Number(data.summarized_message_count ?? 0)
    };
  }

  async saveConversationSummary(
    userId: string,
    rollingSummary: string,
    summarizedMessageCount: number,
    expectedSummarizedMessageCount: number
  ): Promise<void> {
    const { data, error } = await this.client
      .from("conversations")
      .update({
        rolling_summary: rollingSummary,
        summarized_message_count: summarizedMessageCount,
        updated_at: new Date().toISOString()
      })
      .eq("user_id", userId)
      .eq("summarized_message_count", expectedSummarizedMessageCount)
      .select("id")
      .maybeSingle();
    if (error) this.throwError("更新对话摘要", error);
    if (!data) throw new StoreConflictError("对话摘要已被其他任务更新");
  }

  async getUserModel(userId: string): Promise<UserModel> {
    await this.ensureUser(userId);
    const { data, error } = await this.client.from("user_models").select("*").eq("user_id", userId).single();
    if (error) this.throwError("读取用户模型", error);
    return mapUserModel(data);
  }

  async saveUserModel(model: UserModel, expectedVersion: number): Promise<UserModel> {
    const { data, error } = await this.client
      .from("user_models")
      .update({
        vibe_narrative: model.vibeNarrative,
        long_term_profile: model.longTermProfile,
        current_intent: model.currentIntent,
        social_history: model.socialHistory,
        feedback_memory: model.feedbackMemory,
        multimodal_understanding: model.multimodalUnderstanding,
        version: model.version,
        updated_at: model.updatedAt
      })
      .eq("user_id", model.userId)
      .eq("version", expectedVersion)
      .select("*")
      .maybeSingle();
    if (error) this.throwError("更新用户模型", error);
    if (!data) throw new StoreConflictError("用户模型已被其他任务更新");
    return mapUserModel(data);
  }

  async listActiveMemories(userId: string, limit = 128): Promise<UserMemory[]> {
    await this.ensureUser(userId);
    const { data, error } = await this.client
      .from("user_memories")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("last_confirmed_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 128));
    if (error) this.throwError("读取用户记忆", error);
    return (data ?? []).map((row) => mapMemory(row));
  }

  async applyMemoryChanges(input: ApplyMemoryChangesInput): Promise<ApplyMemoryChangesResult> {
    const { data, error } = await this.client.rpc("apply_user_memory_changes", {
      p_user_id: input.userId,
      p_source_type: input.sourceType,
      p_source_id: input.sourceId,
      p_explicitness: input.explicitness,
      p_candidates: input.candidates,
      p_forget_memory_ids: input.forgetMemoryIds,
      p_forget_all: input.forgetAll
    });
    if (error) this.throwError("更新用户记忆", error);
    const result = unwrapRpcData(data) as {
      memories?: JsonRow[];
      forgotten_count?: number;
      forgottenCount?: number;
    };
    return {
      memories: (result.memories ?? []).map((row) => mapMemory(row)),
      forgottenCount: Number(result.forgotten_count ?? result.forgottenCount ?? 0)
    };
  }

  async getMemoryProfile(userId: string): Promise<UserMemoryProfile> {
    await this.ensureUser(userId);
    const { error: expirationError } = await this.client.rpc("expire_user_memories", {
      p_user_id: userId
    });
    if (expirationError) this.throwError("清理过期用户记忆", expirationError);
    const { data, error } = await this.client
      .from("user_memory_profiles")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error) this.throwError("读取用户记忆画像", error);
    return mapMemoryProfile(data);
  }

  async saveMemoryProfile(
    profile: UserMemoryProfile,
    expectedVersion: number
  ): Promise<UserMemoryProfile> {
    const { data, error } = await this.client
      .from("user_memory_profiles")
      .update({
        profile_narrative: profile.profileNarrative,
        matching_narrative: profile.matchingNarrative,
        source_memory_ids: profile.sourceMemoryIds,
        source_watermark: profile.sourceWatermark,
        version: profile.version,
        stale: profile.stale,
        updated_at: profile.updatedAt
      })
      .eq("user_id", profile.userId)
      .eq("version", expectedVersion)
      .select("*")
      .maybeSingle();
    if (error) this.throwError("更新用户记忆画像", error);
    if (!data) throw new StoreConflictError("用户记忆画像已被其他任务更新");
    return mapMemoryProfile(data);
  }

  async markMemoryProfileStale(userId: string): Promise<void> {
    const { error } = await this.client
      .from("user_memory_profiles")
      .update({ stale: true, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) this.throwError("标记用户记忆画像待更新", error);
  }

  async recordMemoryUsage(userId: string, memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    const { error } = await this.client.rpc("record_user_memory_usage", {
      p_user_id: userId,
      p_memory_ids: [...new Set(memoryIds)]
    });
    if (error) this.throwError("记录用户记忆使用", error);
  }

  async saveMultimodalInput(input: MultimodalRecordInput): Promise<string> {
    await this.ensureUser(input.userId);
    if (!input.storagePath.startsWith(`${input.userId}/`) || input.storagePath.includes("..")) {
      throw new StoreConflictError("多模态文件不属于当前用户");
    }
    const { data, error } = await this.client
      .from("multimodal_inputs")
      .insert({
        user_id: input.userId,
        input_type: input.kind,
        storage_path: input.storagePath,
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
        user_hint: input.hint ?? null,
        status: "pending"
      })
      .select("id")
      .single();
    if (error) this.throwError("保存多模态输入", error);
    return String(data.id);
  }

  async createSignedUpload(storagePath: string): Promise<{ path: string; token: string }> {
    const { data, error } = await this.client.storage.from("tomeet-multimodal").createSignedUploadUrl(storagePath);
    if (error) this.throwError("生成文件上传地址", error);
    return { path: data.path, token: data.token };
  }

  async uploadFile(storagePath: string, mimeType: string, bytes: Uint8Array): Promise<void> {
    const { error } = await this.client.storage
      .from("tomeet-multimodal")
      .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
    if (error) this.throwError("上传多模态文件", error);
  }

  async resolveStorageUrl(storagePath: string): Promise<string> {
    const { data, error } = await this.client.storage.from("tomeet-multimodal").createSignedUrl(storagePath, 300);
    if (error) this.throwError("生成文件访问地址", error);
    return data.signedUrl;
  }

  async updateMultimodalInput(inputId: string, understanding: Record<string, unknown>): Promise<void> {
    const { error } = await this.client
      .from("multimodal_inputs")
      .update({ understanding, status: "completed", processed_at: new Date().toISOString() })
      .eq("id", inputId);
    if (error) this.throwError("更新多模态理解", error);
  }

  async createMatchRequest(userId: string, intentSnapshot: Record<string, unknown>): Promise<MatchRequest> {
    const { data, error } = await this.client.rpc("create_match_request", {
      p_user_id: userId,
      p_intent_snapshot: intentSnapshot
    });
    if (error) this.throwError("创建匹配请求", error);
    return mapMatchRequest(unwrapRpcData(data) as JsonRow);
  }

  async getMatchRequest(requestId: string): Promise<MatchRequest | null> {
    const { data, error } = await this.client.from("match_requests").select("*").eq("id", requestId).maybeSingle();
    if (error) this.throwError("读取匹配请求", error);
    return data ? mapMatchRequest(data) : null;
  }

  async getLatestMatchRequestForUser(userId: string): Promise<MatchRequest | null> {
    const { data, error } = await this.client
      .from("match_requests")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) this.throwError("读取用户最近匹配请求", error);
    return data ? mapMatchRequest(data) : null;
  }

  async cancelMatchRequest(requestId: string): Promise<MatchRequest> {
    const { data, error } = await this.client.rpc("cancel_match_request", { p_request_id: requestId });
    if (error) this.throwError("取消匹配请求", error);
    return mapMatchRequest(unwrapRpcData(data) as JsonRow);
  }

  async listMatchCandidates(limit = 50): Promise<MatchCandidate[]> {
    const { data, error } = await this.client.rpc("list_match_candidates", { p_limit: Math.min(limit, 100) });
    if (error) this.throwError("读取匹配候选人", error);
    return ((data ?? []) as Array<{
      request: JsonRow;
      user_model: JsonRow;
      matching_narrative?: unknown;
    }>).map((row) => ({
      request: mapMatchRequest(row.request),
      userModel: mapUserModel(row.user_model),
      matchingNarrative: typeof row.matching_narrative === "string"
        ? row.matching_narrative
        : undefined
    }));
  }

  async listOfflineGames(): Promise<OfflineGame[]> {
    const { data, error } = await this.client.from("offline_games").select("*").eq("active", true).order("name");
    if (error) this.throwError("读取游戏目录", error);
    return (data ?? []).map((row) => mapGame(row));
  }

  async createRoomFromDecision(decision: MatchDecision, sourceJobId?: string): Promise<string> {
    const { data, error } = await this.client.rpc("create_match_room", {
      p_decision: decision,
      p_source_job_id: sourceJobId ?? null
    });
    if (error) this.throwError("创建匹配房间", error);
    return String(data);
  }

  async getRoom(roomId: string): Promise<MatchRoom | null> {
    const { data, error } = await this.client.rpc("get_match_room", { p_room_id: roomId });
    if (error) this.throwError("读取房间", error);
    if (!data) return null;
    return matchRoomSchema.parse(data);
  }

  async getLatestRoomForUser(userId: string): Promise<MatchRoom | null> {
    const { data, error } = await this.client
      .from("room_members")
      .select("room_id,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) this.throwError("读取用户最近房间", error);
    return data ? this.getRoom(String(data.room_id)) : null;
  }

  async confirmRoom(roomId: string, userId: string): Promise<MatchRoom> {
    const { data, error } = await this.client.rpc("confirm_room_member", {
      p_room_id: roomId,
      p_user_id: userId
    });
    if (error) this.throwError("确认房间", error);
    return matchRoomSchema.parse(data);
  }

  async completeRoom(roomId: string): Promise<MatchRoom> {
    const { data, error } = await this.client.rpc("complete_match_room", { p_room_id: roomId });
    if (error) this.throwError("完成活动", error);
    return matchRoomSchema.parse(data);
  }

  async saveFeedback(feedback: PostEventFeedback): Promise<string> {
    const { data, error } = await this.client.rpc("save_post_event_feedback", {
      p_feedback: feedback
    });
    if (error) this.throwError("保存活动反馈", error);
    return String(data);
  }

  async enqueueJob(input: EnqueueJobInput): Promise<LlmJob> {
    const { data, error } = await this.client.rpc("enqueue_llm_job", {
      p_job_type: input.type,
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
      p_max_attempts: input.maxAttempts ?? 3,
      p_partition_key: input.partitionKey ?? null
    });
    if (error) this.throwError("创建智能任务", error);
    return mapJob(unwrapRpcData(data) as JsonRow);
  }

  async getJob(jobId: string): Promise<LlmJob | null> {
    const { data, error } = await this.client.from("llm_jobs").select("*").eq("id", jobId).maybeSingle();
    if (error) this.throwError("读取智能任务", error);
    return data ? mapJob(data) : null;
  }

  async claimJob(workerId: string): Promise<LlmJob | null> {
    const { data, error } = await this.client.rpc("claim_llm_job", { p_worker_id: workerId });
    if (error) this.throwError("领取智能任务", error);
    const row = unwrapRpcData(data);
    return row ? mapJob(row as JsonRow) : null;
  }

  async completeJob(jobId: string, result: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.rpc("complete_llm_job", { p_job_id: jobId, p_result: result });
    if (error) this.throwError("完成智能任务", error);
  }

  async failJob(jobId: string, errorMessage: string): Promise<void> {
    const { error } = await this.client.rpc("fail_llm_job", { p_job_id: jobId, p_error: errorMessage });
    if (error) this.throwError("标记智能任务失败", error);
  }

  async ping(): Promise<void> {
    const { error } = await this.client.from("offline_games").select("id", { head: true, count: "exact" }).limit(1);
    if (error) this.throwError("Supabase 健康检查", error);
  }
}
