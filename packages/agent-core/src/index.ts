import type {
  MemoryExtractionResult,
  MemoryProfileDraft,
  PostEventFeedback,
  UserMemory,
  UserMemoryProfile,
  UserMemorySourceType,
  UserModel,
  WebSearchMeta
} from "@tomeet/contracts";
import type { AgentContext } from "./context.js";
import {
  defaultMemoryExpiration,
  selectRelevantMemories,
  truncateToEstimatedTokens
} from "./memory.js";

export * from "./context.js";
export * from "./memory.js";

export type AgentAction =
  | { type: "start_match"; intent: Record<string, unknown> }
  | { type: "confirm_room" }
  | { type: "complete_room" }
  | {
      type: "submit_feedback";
      peopleFeedback: string;
      gameFeedback: string;
      connectionUserIds: string[];
      nextIntent: string;
    };

export interface MemoryLookupPlan {
  queries: string[];
  reviewSuggested: boolean;
}

export interface ConversationPlan {
  replyDraft: string;
  socialIntentDetected: boolean;
  currentIntent?: Record<string, unknown>;
  actions: AgentAction[];
  memoryPlan: MemoryLookupPlan;
}

export interface ConversationInsight {
  reply: string;
  socialIntentDetected: boolean;
  currentIntent?: Record<string, unknown>;
  actions: AgentAction[];
  usedMemoryIds: string[];
  memoryReviewSuggested: boolean;
  webSearch?: WebSearchMeta;
}

export interface FeedbackInsight {
  currentIntent: Record<string, unknown>;
}

export interface MemoryExtractionInput {
  userId: string;
  sourceType: UserMemorySourceType;
  sourceId: string;
  content: string;
  assistantReply?: string;
  activeMemoryIndex: UserMemory[];
}

export type MemoryLookup = (queries: string[]) => Promise<UserMemory[]>;

export interface AgentIntelligence {
  reply(
    context: AgentContext,
    userContent: string,
    lookupMemories?: MemoryLookup
  ): Promise<ConversationInsight>;
  summarizeConversation(previousCheckpoint: string, messages: import("@tomeet/contracts").Message[]): Promise<string>;
  understandMultimodal(input: {
    kind: "image" | "audio";
    storagePath: string;
    mimeType: string;
    hint?: string;
  }): Promise<Record<string, unknown>>;
  reflectOnFeedback(feedback: PostEventFeedback, userModel: UserModel): Promise<FeedbackInsight>;
  extractMemories(input: MemoryExtractionInput): Promise<MemoryExtractionResult>;
  consolidateMemoryProfile(
    memories: UserMemory[],
    previousProfile: UserMemoryProfile
  ): Promise<MemoryProfileDraft>;
}

const socialIntentPatterns = [
  /想(认识|结识|找|约|参加).{0,12}(朋友|人|活动|局)/u,
  /想.{0,8}(社交|线下见面|一起玩)/u,
  /(组个局|找搭子|约活动|参加活动)/u,
  /(meet|hang out|make friends|socialize)/iu
];

function mockMemoryQueries(userContent: string): string[] {
  const referencesPast = /(之前|上次|还记得|我喜欢|我的|适合我|忘记|别记|删除|改成|不是)/u.test(userContent);
  return referencesPast ? [userContent.slice(0, 200)] : [];
}

function mockForgetIds(content: string, memories: UserMemory[]): string[] {
  if (!/(忘记|别记|删除|清除)/u.test(content)) return [];
  const query = content.replace(/.*?(忘记|别记|删除|清除)(一下|关于|掉)?/u, "").trim();
  if (!query) return memories.map((memory) => memory.id);
  return selectRelevantMemories(memories, [query], 6).map((memory) => memory.id);
}

function mockCandidates(content: string): MemoryExtractionResult["candidates"] {
  const candidates: MemoryExtractionResult["candidates"] = [];
  const preferredName = /(?:我叫|叫我)([\p{L}\p{N}_-]{1,40})/u.exec(content)?.[1];
  if (preferredName) {
    candidates.push({
      kind: "stable_fact",
      stableKey: "preferred_name",
      content: `用户希望被称为${preferredName}`,
      expiresAt: null
    });
  }

  const preference = /我(?:很|比较|特别)?喜欢([^，。！？\n]{1,80})/u.exec(content)?.[1]?.trim();
  if (preference) {
    candidates.push({
      kind: "preference",
      stableKey: `preference:${preference}`,
      content: `用户明确表示喜欢${preference}`,
      expiresAt: null
    });
  }

  const boundary = /我(?:不喜欢|不想|不要)([^，。！？\n]{1,80})/u.exec(content)?.[1]?.trim();
  if (boundary) {
    candidates.push({
      kind: "boundary",
      stableKey: `boundary:${boundary}`,
      content: `用户明确表示不喜欢或不希望${boundary}`,
      expiresAt: null
    });
  }

  const temporary = /(?:最近|这几天|这周)([^。！？\n]{2,100})/u.exec(content)?.[0]?.trim();
  if (temporary) {
    candidates.push({
      kind: "temporary_state",
      stableKey: "recent_state",
      content: `用户明确表示${temporary}`,
      expiresAt: defaultMemoryExpiration("temporary_state")
    });
  }
  return candidates.slice(0, 8);
}

export class MockAgentIntelligence implements AgentIntelligence {
  async reply(
    context: AgentContext,
    userContent: string,
    lookupMemories?: MemoryLookup
  ): Promise<ConversationInsight> {
    const socialIntentDetected = socialIntentPatterns.some((pattern) => pattern.test(userContent));
    const currentIntent = socialIntentDetected
      ? {
          expressedAt: new Date().toISOString(),
          rawText: userContent
        }
      : undefined;
    const actions: AgentAction[] = [];
    const normalized = userContent.trim();
    let reply = socialIntentDetected
      ? "我听到你现在确实想认识一些合适的人。我会根据你持续表达出来的整体感受开始寻找小组。"
      : "我在听。你可以继续告诉我最近的状态、经历和当下的感觉。";

    if (context.room?.status === "completed" && /(感觉|反馈|聊得|喜欢|不喜欢|下次|尴尬|开心|一般)/u.test(normalized)) {
      actions.push({
        type: "submit_feedback",
        peopleFeedback: normalized,
        gameFeedback: normalized,
        connectionUserIds: [],
        nextIntent: normalized
      });
      reply = "我记下了这次对人和游戏的感受，也会用它改进下一次匹配。";
    } else if (context.room?.status === "confirming" && /(确认|参加|可以去|愿意去|没问题)/u.test(normalized)) {
      actions.push({ type: "confirm_room" });
      reply = "好的，我来为你确认参加。";
    } else if (context.room?.status === "confirmed" && /(结束|完成|参加完|活动完)/u.test(normalized)) {
      actions.push({ type: "complete_room" });
      reply = "收到，我会把这次线下活动标记为已完成。";
    } else if (socialIntentDetected && context.matchRequest?.status !== "matching") {
      actions.push({ type: "start_match", intent: currentIntent ?? { rawText: normalized } });
    } else if (socialIntentDetected && context.matchRequest?.status === "matching") {
      reply = "你的匹配已经在等待中，完成后我会直接在这里告诉你。";
    }

    const queries = mockMemoryQueries(userContent);
    const memories = queries.length && lookupMemories ? await lookupMemories(queries) : [];
    if (memories.length > 0 && actions.length === 0) {
      reply = `${reply}\n\n我也记得：${memories.map((memory) => memory.content).join("；")}`;
    }
    return {
      reply,
      socialIntentDetected,
      currentIntent,
      actions,
      usedMemoryIds: memories.map((memory) => memory.id),
      memoryReviewSuggested: /(忘记|别记|删除|清除|改成|不是)/u.test(userContent)
    };
  }

  async summarizeConversation(previousCheckpoint: string, messages: import("@tomeet/contracts").Message[]): Promise<string> {
    const additions = messages
      .map((message) => `${message.role === "user" ? "用户" : "Agent"}：${message.content}`)
      .join("\n");
    return truncateToEstimatedTokens(
      [previousCheckpoint, additions].filter(Boolean).join("\n"),
      1_000
    );
  }

  async understandMultimodal(input: {
    kind: "image" | "audio";
    storagePath: string;
    mimeType: string;
    hint?: string;
  }): Promise<Record<string, unknown>> {
    return {
      kind: input.kind,
      reply: "我已经理解了这份材料，会把它作为近期印象而不是确定的个人事实。",
      summary: input.hint || `用户提供了一份${input.kind === "image" ? "图片" : "短录音"}材料。`,
      recentImpression: input.hint
        ? `用户通过${input.kind === "image" ? "图片" : "录音"}传递的近期印象：${input.hint}`
        : `用户提供了一份${input.kind === "image" ? "视觉" : "声音"}材料。`,
      source: input.storagePath,
      mock: true
    };
  }

  async reflectOnFeedback(feedback: PostEventFeedback, _userModel: UserModel): Promise<FeedbackInsight> {
    return { currentIntent: { nextIntent: feedback.nextIntent } };
  }

  async extractMemories(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
    const forgetMemoryIds = mockForgetIds(input.content, input.activeMemoryIndex);
    return {
      candidates: forgetMemoryIds.length > 0 ? [] : mockCandidates(input.content),
      forgetMemoryIds,
      forgetAll: /(忘记|删除|清除)(我|关于我)?(的)?(所有|全部)(个人信息|记忆|资料)?/u.test(input.content),
      rejectedSensitiveCount: 0
    };
  }

  async consolidateMemoryProfile(
    memories: UserMemory[],
    _previousProfile: UserMemoryProfile
  ): Promise<MemoryProfileDraft> {
    const profileNarrative = truncateToEstimatedTokens(
      memories.map((memory) => memory.content).join("；"),
      1_200
    );
    const matchingNarrative = truncateToEstimatedTokens(
      memories
        .filter((memory) => [
          "preference",
          "interaction_preference",
          "social_learning",
          "boundary"
        ].includes(memory.kind))
        .map((memory) => memory.content)
        .join("；"),
      1_000
    );
    return {
      profileNarrative,
      matchingNarrative,
      sourceMemoryIds: memories.map((memory) => memory.id).slice(0, 128)
    };
  }
}
