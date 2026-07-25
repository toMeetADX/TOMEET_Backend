import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  adventurexOnboardingStateSchema,
  adventurexTestPoolStatusSchema,
  channelIdentitySchema,
  llmJobSchema,
  matchChoiceSchema,
  matchDraftSchema,
  matchOptionContextSchema,
  matchOptionOfferSchema,
  matchRequestSchema,
  matchRoundSchema,
  matchRoomSchema,
  messageSchema,
  offlineGameSchema,
  socialHookSchema,
  userMemoryProfileSchema,
  userMemorySchema,
  userModelSchema,
  type AdventurexLanguage,
  type LlmJob,
  type AdventurexOnboardingState,
  type AdventurexTestPoolStatus,
  type ChannelIdentity,
  type ChannelProvider,
  type FinalRoomDecision,
  type MatchChoice,
  type MatchDecision,
  type MatchOptionContext,
  type MatchOptionOffer,
  type MatchRequest,
  type MatchRound,
  type MatchRoom,
  type Message,
  type OfflineGame,
  type PostEventFeedback,
  type SaveMatchChoicesInput,
  type SocialHook,
  type SocialHookDraft,
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
  DraftChangeNotification,
  EnqueueJobInput,
  LinkChannelIdentityInput,
  MultimodalRecordInput,
  RoomChangeNotification,
  RoundSettlementState,
  SaveRoundPlanInput
} from "./store.js";
import { StoreConflictError, StoreNotFoundError } from "./store.js";

type JsonRow = Record<string, unknown>;

function unwrapRpcData(data: unknown): unknown {
  if (Array.isArray(data) && data.length === 1) return data[0];
  return data;
}

function normalizeDateTime(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function mapMessage(row: JsonRow): Message {
  return messageSchema.parse({
    id: row.id,
    userId: row.user_id ?? row.userId,
    role: row.role,
    content: row.content,
    sourceChannel: row.source_channel ?? row.sourceChannel ?? "legacy",
    replyToMessageId: row.reply_to_message_id ?? row.replyToMessageId ?? null,
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt)
  });
}

function mapChannelIdentity(row: JsonRow): ChannelIdentity {
  return channelIdentitySchema.parse({
    provider: row.provider,
    externalUserId: row.external_user_id ?? row.externalUserId,
    userId: row.user_id ?? row.userId,
    displayName: row.display_name ?? row.displayName ?? null,
    linkedAt: normalizeDateTime(row.linked_at ?? row.linkedAt)
  });
}

function mapUserModel(row: JsonRow): UserModel {
  return userModelSchema.parse({
    userId: row.id ?? row.user_id ?? row.userId,
    vibeNarrative: row.vibe_narrative ?? row.vibeNarrative ?? "",
    longTermProfile: row.long_term_profile ?? row.longTermProfile ?? {},
    currentIntent: row.current_intent ?? row.currentIntent ?? {},
    socialHistory: row.social_history ?? row.socialHistory ?? [],
    feedbackMemory: row.feedback_memory ?? row.feedbackMemory ?? [],
    multimodalUnderstanding: row.multimodal_understanding ?? row.multimodalUnderstanding ?? {},
    version: row.user_model_version ?? row.version ?? 0,
    updatedAt: normalizeDateTime(
      row.user_model_updated_at ?? row.updated_at ?? row.updatedAt
    )
  });
}

function mapMatchRequest(row: JsonRow): MatchRequest {
  return matchRequestSchema.parse({
    requestId: row.id ?? row.request_id ?? row.requestId,
    userId: row.user_id ?? row.userId,
    intentSnapshot: row.intent_snapshot ?? row.intentSnapshot ?? {},
    status: row.status,
    phase: row.phase ?? "waiting",
    proactivePushEnabled: row.proactive_push_enabled ?? row.proactivePushEnabled ?? false,
    activeRoundId: row.active_round_id ?? row.activeRoundId ?? null,
    optionsExpiresAt: normalizeDateTime(row.options_expires_at ?? row.optionsExpiresAt ?? null),
    roomId: row.room_id ?? row.roomId ?? null,
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt),
    updatedAt: normalizeDateTime(row.updated_at ?? row.updatedAt)
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
    runAt: normalizeDateTime(row.run_at ?? row.runAt ?? row.created_at ?? row.createdAt),
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt),
    updatedAt: normalizeDateTime(row.updated_at ?? row.updatedAt)
  });
}

function mapOnboardingState(row: JsonRow): AdventurexOnboardingState {
  return adventurexOnboardingStateSchema.parse({
    userId: row.user_id ?? row.userId ?? row.id,
    stage: row.adventurex_stage ?? row.stage,
    imageDeclined: row.adventurex_image_declined ?? row.image_declined ?? row.imageDeclined ?? false,
    preferredLanguage: row.adventurex_preferred_language ?? row.preferred_language ?? row.preferredLanguage ?? "zh",
    boundaryPromptedAt: normalizeDateTime(
      row.adventurex_boundary_prompted_at ?? row.boundary_prompted_at ?? row.boundaryPromptedAt ?? null
    ),
    welcomeSentAt: normalizeDateTime(
      row.adventurex_welcome_sent_at ?? row.welcome_sent_at ?? row.welcomeSentAt ?? null
    ),
    createdAt: normalizeDateTime(
      row.adventurex_state_created_at ?? row.created_at ?? row.createdAt
    ),
    updatedAt: normalizeDateTime(
      row.adventurex_state_updated_at ?? row.updated_at ?? row.updatedAt
    )
  });
}

function mapSocialHook(row: JsonRow): SocialHook {
  return socialHookSchema.parse({
    id: row.id,
    userId: row.user_id ?? row.userId,
    hookText: row.hook_text ?? row.hookText,
    sourceMessageIds: row.source_message_ids ?? row.sourceMessageIds ?? [],
    status: row.status,
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt),
    updatedAt: normalizeDateTime(row.updated_at ?? row.updatedAt)
  });
}

function mapRound(row: JsonRow): MatchRound {
  return matchRoundSchema.parse({
    roundId: row.id ?? row.round_id ?? row.roundId,
    bucketKey: row.bucket_key ?? row.bucketKey,
    status: row.status,
    offerExpiresAt: normalizeDateTime(row.offer_expires_at ?? row.offerExpiresAt ?? null),
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt),
    updatedAt: normalizeDateTime(row.updated_at ?? row.updatedAt)
  });
}

function mapDraft(row: JsonRow) {
  return matchDraftSchema.parse({
    draftId: row.id ?? row.draft_id ?? row.draftId,
    roundId: row.round_id ?? row.roundId,
    offlineGameId: row.offline_game_id ?? row.offlineGameId,
    status: row.status,
    version: row.version ?? 0,
    targetPlayers: row.target_players ?? row.targetPlayers,
    candidateRequestIds: row.candidate_request_ids ?? row.candidateRequestIds ?? [],
    rationale: row.rationale ?? "现场互动候选局",
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt),
    expiresAt: normalizeDateTime(row.expires_at ?? row.expiresAt)
  });
}

function mapOffer(row: JsonRow): MatchOptionOffer {
  return matchOptionOfferSchema.parse({
    offerId: row.id ?? row.offer_id ?? row.offerId,
    requestId: row.request_id ?? row.requestId,
    roundId: row.round_id ?? row.roundId,
    sourceType: row.source_type ?? row.sourceType,
    draftId: row.draft_id ?? row.draftId ?? null,
    roomId: row.room_id ?? row.roomId ?? null,
    sourceVersion: row.source_version ?? row.sourceVersion ?? 0,
    optionNumber: row.option_number ?? row.optionNumber,
    offlineGameId: row.offline_game_id ?? row.offlineGameId,
    previewText: row.preview_text ?? row.previewText,
    hooks: row.hooks ?? [],
    status: row.status,
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt),
    respondedAt: normalizeDateTime(row.responded_at ?? row.respondedAt ?? null)
  });
}

function mapChoice(row: JsonRow): MatchChoice {
  return matchChoiceSchema.parse({
    choiceId: row.id ?? row.choice_id ?? row.choiceId,
    requestId: row.request_id ?? row.requestId,
    roundId: row.round_id ?? row.roundId,
    sourceType: row.source_type ?? row.sourceType,
    draftId: row.draft_id ?? row.draftId ?? null,
    roomId: row.room_id ?? row.roomId ?? null,
    preferenceRank: row.preference_rank ?? row.preferenceRank,
    requiredHookIds: row.required_hook_ids ?? row.requiredHookIds ?? [],
    rawUserText: row.raw_user_text ?? row.rawUserText,
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt)
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
    lastConfirmedAt: normalizeDateTime(row.last_confirmed_at ?? row.lastConfirmedAt),
    lastUsedAt: normalizeDateTime(row.last_used_at ?? row.lastUsedAt ?? null),
    expiresAt: normalizeDateTime(row.expires_at ?? row.expiresAt ?? null),
    createdAt: normalizeDateTime(row.created_at ?? row.createdAt),
    updatedAt: normalizeDateTime(row.updated_at ?? row.updatedAt)
  });
}

function mapMemoryProfile(row: JsonRow): UserMemoryProfile {
  return userMemoryProfileSchema.parse({
    userId: row.user_id ?? row.userId,
    profileNarrative: row.profile_narrative ?? row.profileNarrative ?? "",
    matchingNarrative: row.matching_narrative ?? row.matchingNarrative ?? "",
    sourceMemoryIds: row.source_memory_ids ?? row.sourceMemoryIds ?? [],
    sourceWatermark: normalizeDateTime(row.source_watermark ?? row.sourceWatermark ?? null),
    version: row.version ?? 0,
    stale: row.stale ?? false,
    updatedAt: normalizeDateTime(row.updated_at ?? row.updatedAt)
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

  async ensureAdventurexOnboardingState(userId: string): Promise<AdventurexOnboardingState> {
    await this.ensureUser(userId);
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) this.throwError("读取 AdventureX 引导状态", error);
    return mapOnboardingState(data);
  }

  async startAdventurexOnboarding(
    userId: string,
    language: AdventurexLanguage = "zh"
  ): Promise<Message | null> {
    const { data, error } = await this.client.rpc("start_adventurex_onboarding", {
      p_user_id: userId,
      p_language: language
    });
    if (error) this.throwError("开始 AdventureX 引导", error);
    const result = unwrapRpcData(data) as { message?: JsonRow | null } | JsonRow;
    const message = ("message" in result ? result.message : result) as JsonRow | null | undefined;
    return message ? mapMessage(message) : null;
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
    const { data, error } = await this.client.rpc("update_adventurex_onboarding_state", {
      p_user_id: userId,
      p_stage: patch.stage ?? null,
      p_image_declined: patch.imageDeclined ?? null,
      p_preferred_language: patch.preferredLanguage ?? null,
      p_boundary_prompted: patch.boundaryPrompted ?? false
    });
    if (error) this.throwError("更新 AdventureX 引导状态", error);
    return mapOnboardingState(unwrapRpcData(data) as JsonRow);
  }

  async resolveChannelIdentity(
    provider: ChannelProvider,
    externalUserId: string
  ): Promise<ChannelIdentity | null> {
    const { data, error } = await this.client
      .from("channel_identities")
      .select("provider,external_user_id,user_id,display_name,linked_at")
      .eq("provider", provider)
      .eq("external_user_id", externalUserId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapChannelIdentity(data as JsonRow) : null;
  }

  async linkChannelIdentity(input: LinkChannelIdentityInput): Promise<ChannelIdentity> {
    const { data, error } = await this.client
      .from("channel_identities")
      .insert({
        provider: input.provider,
        external_user_id: input.externalUserId,
        user_id: input.userId,
        display_name: input.displayName ?? null
      })
      .select("provider,external_user_id,user_id,display_name,linked_at")
      .single();
    if (error?.code === "23503") throw new StoreNotFoundError("用户不存在");
    if (error?.code === "23505") throw new StoreConflictError("渠道身份或用户已绑定");
    if (error) throw error;
    return mapChannelIdentity(data as JsonRow);
  }

  async appendMessage(input: {
    userId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
    sourceChannel?: Message["sourceChannel"];
    replyToMessageId?: string | null;
  }): Promise<Message> {
    const { data, error } = await this.client.rpc("append_agent_message", {
      p_user_id: input.userId,
      p_role: input.role,
      p_content: input.content,
      p_idempotency_key: input.idempotencyKey ?? null,
      p_source_channel: input.sourceChannel ?? "legacy",
      p_reply_to_message_id: input.replyToMessageId ?? null
    });
    if (error) this.throwError("写入消息", error);
    return mapMessage(unwrapRpcData(data) as JsonRow);
  }

  async setWechatResponseGeneration(connectionId: string, generationToken: string): Promise<void> {
    const { error } = await this.client.rpc("set_wechat_response_generation", {
      p_connection_id: connectionId,
      p_generation_token: generationToken
    });
    if (error) this.throwError("更新微信回复代次", error);
  }

  async isWechatResponseGenerationCurrent(
    connectionId: string,
    generationToken: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc("is_wechat_response_generation_current", {
      p_connection_id: connectionId,
      p_generation_token: generationToken
    });
    if (error) this.throwError("检查微信回复代次", error);
    return data === true;
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
    const { data, error } = await this.client.rpc(
      "append_agent_message_if_wechat_generation_current",
      {
        p_connection_id: input.connectionId,
        p_generation_token: input.generationToken,
        p_user_id: input.userId,
        p_role: input.role,
        p_content: input.content,
        p_idempotency_key: input.idempotencyKey ?? null,
        p_source_channel: input.sourceChannel ?? "wechat",
        p_reply_to_message_id: input.replyToMessageId ?? null
      }
    );
    if (error) this.throwError("按微信回复代次写入消息", error);
    const result = unwrapRpcData(data);
    return result ? mapMessage(result as JsonRow) : null;
  }

  async listRecentMessages(userId: string, limit = 50): Promise<Message[]> {
    const { data, error } = await this.client
      .from("messages")
      .select("id,user_id,role,content,source_channel,reply_to_message_id,created_at")
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
      .select("id,user_id,role,content,source_channel,reply_to_message_id,created_at")
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
    const { data, error } = await this.client.from("users").select("*").eq("id", userId).single();
    if (error) this.throwError("读取用户模型", error);
    return mapUserModel(data);
  }

  async saveUserModel(model: UserModel, expectedVersion: number): Promise<UserModel> {
    const { data, error } = await this.client
      .from("users")
      .update({
        vibe_narrative: model.vibeNarrative,
        long_term_profile: model.longTermProfile,
        current_intent: model.currentIntent,
        social_history: model.socialHistory,
        feedback_memory: model.feedbackMemory,
        multimodal_understanding: model.multimodalUnderstanding,
        user_model_version: model.version,
        user_model_updated_at: model.updatedAt
      })
      .eq("id", model.userId)
      .eq("user_model_version", expectedVersion)
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

  async listActiveSocialHooks(userId: string, limit = 32): Promise<SocialHook[]> {
    const { data, error } = await this.client.rpc("list_active_social_hooks", {
      p_user_id: userId,
      p_limit: Math.min(Math.max(limit, 1), 128)
    });
    if (error) this.throwError("读取社交钩子", error);
    return ((data ?? []) as JsonRow[]).map((row) => mapSocialHook(row));
  }

  async saveSocialHooks(userId: string, hooks: SocialHookDraft[]): Promise<SocialHook[]> {
    if (hooks.length === 0) return [];
    const { data, error } = await this.client.rpc("save_social_hooks", {
      p_user_id: userId,
      p_hooks: hooks
    });
    if (error) this.throwError("保存社交钩子", error);
    return ((data ?? []) as JsonRow[]).map((row) => mapSocialHook(row));
  }

  async forgetSocialHook(userId: string, hookId: string): Promise<void> {
    const { error } = await this.client.rpc("forget_social_hook", {
      p_user_id: userId,
      p_hook_id: hookId
    });
    if (error) this.throwError("忘记社交钩子", error);
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

  async restartMatch(endedRequestId: string): Promise<MatchRequest> {
    const { data, error } = await this.client.rpc("restart_match_request", {
      p_cancelled_request_id: endedRequestId
    });
    if (error) this.throwError("重新匹配", error);
    return mapMatchRequest(unwrapRpcData(data) as JsonRow);
  }

  async setMatchRequestInterest(
    requestId: string,
    input: {
      phase: "waiting" | "push_consent" | "watching";
      proactivePushEnabled: boolean;
      clearRound?: boolean;
    }
  ): Promise<MatchRequest> {
    const { data, error } = await this.client.rpc("set_match_request_interest", {
      p_request_id: requestId,
      p_phase: input.phase,
      p_proactive_push_enabled: input.proactivePushEnabled,
      p_clear_round: input.clearRound ?? false
    });
    if (error) this.throwError("更新匹配意愿", error);
    return mapMatchRequest(unwrapRpcData(data) as JsonRow);
  }

  async getAdventurexTestPoolStatus(ownerUserId: string): Promise<AdventurexTestPoolStatus> {
    const { data, error } = await this.client.rpc("get_adventurex_test_pool_status", {
      p_owner_user_id: ownerUserId
    });
    if (error) this.throwError("读取虚拟测试用户池", error);
    return adventurexTestPoolStatusSchema.parse(unwrapRpcData(data));
  }

  async configureAdventurexTestPool(
    ownerUserId: string,
    input: { enabled: boolean; desiredUserCount: number }
  ): Promise<AdventurexTestPoolStatus> {
    const { data, error } = await this.client.rpc("configure_adventurex_test_pool", {
      p_owner_user_id: ownerUserId,
      p_enabled: input.enabled,
      p_desired_user_count: input.desiredUserCount
    });
    if (error) this.throwError("配置虚拟测试用户池", error);
    return adventurexTestPoolStatusSchema.parse(unwrapRpcData(data));
  }

  async prepareAdventurexTestPool(ownerUserId: string): Promise<MatchRequest[]> {
    const { data, error } = await this.client.rpc("prepare_adventurex_test_pool", {
      p_owner_user_id: ownerUserId
    });
    if (error) this.throwError("准备虚拟测试用户池", error);
    return ((data ?? []) as JsonRow[]).map((row) => mapMatchRequest(row));
  }

  async createOrGetMatchRound(bucketKey: string, scheduledAt: string): Promise<MatchRound> {
    const { data, error } = await this.client.rpc("create_or_get_match_round", {
      p_bucket_key: bucketKey,
      p_scheduled_at: scheduledAt
    });
    if (error) this.throwError("创建匹配轮次", error);
    return mapRound(unwrapRpcData(data) as JsonRow);
  }

  async addRequestToRound(roundId: string, requestId: string): Promise<void> {
    const { error } = await this.client.rpc("add_request_to_match_round", {
      p_round_id: roundId,
      p_request_id: requestId
    });
    if (error) this.throwError("加入匹配轮次", error);
  }

  async listRoundCandidates(roundId: string): Promise<MatchCandidate[]> {
    const { data, error } = await this.client.rpc("list_match_round_candidates", { p_round_id: roundId });
    if (error) this.throwError("读取轮次候选", error);
    return ((data ?? []) as Array<{
      request: JsonRow;
      user_model: JsonRow;
      matching_narrative?: unknown;
      social_hooks?: JsonRow[];
      matching_priority?: unknown;
    }>).map((row) => ({
      request: mapMatchRequest(row.request),
      userModel: mapUserModel(row.user_model),
      matchingNarrative: typeof row.matching_narrative === "string" ? row.matching_narrative : undefined,
      socialHooks: (row.social_hooks ?? []).map((hook) => mapSocialHook(hook)),
      matchingPriority: row.matching_priority === "active_waiting"
        || row.matching_priority === "confirmation_follow_up"
        || row.matching_priority === "watching"
        ? row.matching_priority
        : undefined
    }));
  }

  async saveRoundProposals(input: SaveRoundPlanInput): Promise<MatchOptionOffer[]> {
    const { data, error } = await this.client.rpc("save_match_round_proposals", {
      p_round_id: input.roundId,
      p_proposal: input.proposal,
      p_offers: input.offers,
      p_offer_expires_at: input.offerExpiresAt
    });
    if (error) this.throwError("保存轮次候选", error);
    return ((data ?? []) as JsonRow[]).map((row) => mapOffer(row));
  }

  async listCurrentMatchOptions(userId: string): Promise<MatchOptionContext | null> {
    const { data, error } = await this.client.rpc("list_current_match_options", { p_user_id: userId });
    if (error) this.throwError("读取当前候选", error);
    const raw = unwrapRpcData(data) as (JsonRow & { options?: JsonRow[] }) | null;
    if (!raw) return null;
    return matchOptionContextSchema.parse({
      requestId: raw.request_id ?? raw.requestId,
      roundId: raw.round_id ?? raw.roundId,
      expiresAt: normalizeDateTime(raw.expires_at ?? raw.expiresAt),
      options: (raw.options ?? []).map((row) => ({
        ...mapOffer(row),
        activityName: row.activity_name ?? row.activityName,
        activityDescription: row.activity_description ?? row.activityDescription
      }))
    });
  }

  async saveMatchChoices(requestId: string, input: SaveMatchChoicesInput): Promise<MatchChoice[]> {
    const { data, error } = await this.client.rpc("save_match_choices", {
      p_request_id: requestId,
      p_preferred_option_number: input.preferredOptionNumber,
      p_accepted_option_numbers: input.acceptedOptionNumbers,
      p_required_hook_ids: input.requiredHookIds,
      p_raw_user_text: input.rawText
    });
    if (error) this.throwError("保存候选选择", error);
    return ((data ?? []) as JsonRow[]).map((row) => mapChoice(row));
  }

  async expireMatchOptions(requestId: string): Promise<void> {
    const { error } = await this.client.rpc("expire_match_options", { p_request_id: requestId });
    if (error) this.throwError("刷新候选", error);
  }

  async getRoundSettlementState(roundId: string): Promise<RoundSettlementState> {
    const { data, error } = await this.client.rpc("get_match_round_settlement_state", { p_round_id: roundId });
    if (error) this.throwError("读取轮次结算状态", error);
    const raw = unwrapRpcData(data) as JsonRow & {
      drafts?: JsonRow[];
      choices?: JsonRow[];
      requests?: JsonRow[];
      hooks?: JsonRow[];
      round?: JsonRow;
    };
    return {
      round: mapRound(raw.round ?? raw),
      drafts: (raw.drafts ?? []).map((row) => mapDraft(row)),
      choices: (raw.choices ?? []).map((row) => mapChoice(row)),
      requests: (raw.requests ?? []).map((row) => mapMatchRequest(row)),
      hooks: (raw.hooks ?? []).map((row) => mapSocialHook(row))
    };
  }

  async settleMatchRound(roundId: string, decisions: FinalRoomDecision[]): Promise<string[]> {
    const { data, error } = await this.client.rpc("settle_match_round", {
      p_round_id: roundId,
      p_decisions: decisions
    });
    if (error) this.throwError("结算匹配轮次", error);
    return (data ?? []).map(String);
  }

  async listSuitableOpenRooms(userId: string, limit = 3): Promise<MatchRoom[]> {
    const { data, error } = await this.client.rpc("list_suitable_open_rooms", {
      p_user_id: userId,
      p_limit: Math.min(Math.max(limit, 1), 10)
    });
    if (error) this.throwError("读取开放局", error);
    return ((data ?? []) as unknown[]).map((row) => matchRoomSchema.parse(row));
  }

  async joinOpenRoom(requestId: string, offerId: string, sourceVersion: number): Promise<MatchRoom> {
    const { data, error } = await this.client.rpc("join_open_match_room", {
      p_request_id: requestId,
      p_offer_id: offerId,
      p_source_version: sourceVersion
    });
    if (error) this.throwError("加入开放局", error);
    return matchRoomSchema.parse(data);
  }

  async listMatchCandidates(limit = 50): Promise<MatchCandidate[]> {
    const { data, error } = await this.client.rpc("list_match_candidates", { p_limit: Math.min(limit, 100) });
    if (error) this.throwError("读取匹配候选人", error);
    return ((data ?? []) as Array<{
      request: JsonRow;
      user_model: JsonRow;
      matching_narrative?: unknown;
      social_hooks?: JsonRow[];
    }>).map((row) => ({
      request: mapMatchRequest(row.request),
      userModel: mapUserModel(row.user_model),
      matchingNarrative: typeof row.matching_narrative === "string"
        ? row.matching_narrative
        : undefined,
      socialHooks: (row.social_hooks ?? []).map((hook) => mapSocialHook(hook))
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
      .neq("participation_status", "withdrawn")
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

  async leaveRoom(roomId: string, userId: string, reason?: string): Promise<MatchRoom> {
    const { data, error } = await this.client.rpc("withdraw_room_member_with_reason", {
      p_room_id: roomId,
      p_user_id: userId,
      p_reason: reason ?? null
    });
    if (error) this.throwError("退出房间", error);
    return matchRoomSchema.parse(data);
  }

  async getRoomIntro(roomId: string, userId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("room_member_intros")
      .select("intro_text")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) this.throwError("读取房间介绍", error);
    return data ? String(data.intro_text) : null;
  }

  async saveRoomIntro(roomId: string, userId: string, introText: string, hookIds: string[]): Promise<void> {
    const { error } = await this.client.rpc("save_room_member_intro", {
      p_room_id: roomId,
      p_user_id: userId,
      p_intro_text: introText,
      p_hook_ids: hookIds
    });
    if (error) this.throwError("保存房间成员介绍", error);
  }

  async listPendingRoomChangeNotifications(limit = 100): Promise<RoomChangeNotification[]> {
    const { data, error } = await this.client.rpc("list_pending_room_change_notifications", {
      p_limit: Math.min(Math.max(limit, 1), 500)
    });
    if (error) this.throwError("读取房间变化通知", error);
    return ((data ?? []) as JsonRow[]).map((row) => ({
      eventId: String(row.event_id ?? row.eventId),
      roomId: String(row.room_id ?? row.roomId),
      userId: String(row.user_id ?? row.userId),
      changeType: String(row.change_type ?? row.changeType),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      idempotencyKey: String(row.idempotency_key ?? row.idempotencyKey)
    }));
  }

  async markRoomChangeNotificationDelivered(eventId: string, userId: string): Promise<void> {
    const { error } = await this.client.rpc("mark_room_change_notification_delivered", {
      p_event_id: eventId,
      p_user_id: userId
    });
    if (error) this.throwError("标记房间变化通知", error);
  }

  async listPendingDraftChangeNotifications(limit = 100): Promise<DraftChangeNotification[]> {
    const { data, error } = await this.client.rpc("list_pending_draft_change_notifications", {
      p_limit: Math.min(Math.max(limit, 1), 500)
    });
    if (error) this.throwError("读取候选局变化通知", error);
    return ((data ?? []) as JsonRow[]).map((row) => ({
      eventId: String(row.event_id ?? row.eventId),
      draftId: String(row.draft_id ?? row.draftId),
      userId: String(row.user_id ?? row.userId),
      changeType: String(row.change_type ?? row.changeType),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      idempotencyKey: String(row.idempotency_key ?? row.idempotencyKey)
    }));
  }

  async markDraftChangeNotificationDelivered(eventId: string, userId: string): Promise<void> {
    const { error } = await this.client.rpc("mark_draft_change_notification_delivered", {
      p_event_id: eventId,
      p_user_id: userId
    });
    if (error) this.throwError("标记候选局变化通知", error);
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

  async enqueueWechatOutboundMessage(message: Message): Promise<void> {
    const { error } = await this.client.rpc("enqueue_wechat_outbound_message", {
      p_user_id: message.userId,
      p_message_id: message.id,
      p_content: message.content
    });
    if (error) this.throwError("创建微信主动消息", error);
  }

  async enqueueJob(input: EnqueueJobInput): Promise<LlmJob> {
    const { data, error } = await this.client.rpc("enqueue_llm_job", {
      p_job_type: input.type,
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
      p_max_attempts: input.maxAttempts ?? 3,
      p_partition_key: input.partitionKey ?? null,
      p_run_at: input.runAt ?? null
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
