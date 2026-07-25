import type {
  AdventurexLanguage,
  AgentProductEvent,
  AgentProductMessage,
  MemoryExtractionResult,
  MemoryProfileDraft,
  PostEventFeedback,
  UserMemory,
  UserMemoryProfile,
  UserMemorySourceType,
  UserModel,
  WebSearchMeta,
  SocialHookDraft
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
  | {
      type: "select_match_options";
      preferredOptionNumber: 1 | 2 | 3 | null;
      acceptedOptionNumbers: Array<1 | 2 | 3>;
      requiredHookIds: string[];
      rawText: string;
    }
  | { type: "refresh_match_options" }
  | { type: "explain_match_option"; optionNumber: 1 | 2 | 3 }
  | { type: "cancel_match" }
  | { type: "restart_match"; intent: Record<string, unknown> }
  | { type: "enable_match_push" }
  | { type: "disable_match_push" }
  | { type: "activate_match" }
  | { type: "leave_room"; reason?: string }
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

export function extractRoomExitReason(userContent: string): string | null {
  const stripped = userContent
    .trim()
    .replace(/(?:我)?(?:想|要)?(?:退出(?:这个局|组局|房间)?|离开(?:这个局|房间)?|不参加了|不去了|去不了了|没法参加了|取消参加)/gu, " ")
    .replace(/^(?:请|麻烦)?(?:帮我)?/u, "")
    .replace(/[，。,.！!？?；;：:\s]+/gu, " ")
    .trim();
  return stripped.length > 0 ? stripped.slice(0, 500) : null;
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
  onboardingTransition:
    | "none"
    | "image_declined"
    | "engaged"
    | "boundary_prompted"
    | "language_zh"
    | "language_en";
  socialIntentDetected: boolean;
  currentIntent?: Record<string, unknown>;
  actions: AgentAction[];
  usedMemoryIds: string[];
  memoryReviewSuggested: boolean;
  socialHooks: SocialHookDraft[];
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
    lookupMemories?: MemoryLookup,
    userMessageId?: string
  ): Promise<ConversationInsight>;
  composeProductMessage(context: AgentContext, event: AgentProductEvent): Promise<AgentProductMessage>;
  summarizeConversation(previousCheckpoint: string, messages: import("@tomeet/contracts").Message[]): Promise<string>;
  understandMultimodal(input: {
    kind: "image" | "audio";
    storagePaths: string[];
    mimeTypes: string[];
    hint?: string;
    preferredLanguage?: AdventurexLanguage;
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

/** Deterministic test/example harness. Production and demo runtimes require HostedLlmIntelligence. */
export class MockAgentIntelligence implements AgentIntelligence {
  async reply(
    context: AgentContext,
    userContent: string,
    lookupMemories?: MemoryLookup,
    userMessageId?: string
  ): Promise<ConversationInsight> {
    const socialIntentDetected = socialIntentPatterns.some((pattern) => pattern.test(userContent));
    const currentIntent = socialIntentDetected
      ? {
          expressedAt: new Date().toISOString(),
          rawText: userContent
        }
      : undefined;
    const actions: AgentAction[] = [];
    const socialHooks: SocialHookDraft[] = [];
    const normalized = userContent.trim();
    let onboardingTransition: ConversationInsight["onboardingTransition"] = "none";
    const previousAssistantMessage = [...context.recentMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    const awaitingRoomExitReason = Boolean(
      previousAssistantMessage
      && /退出/u.test(previousAssistantMessage.content)
      && /(原因|理由)/u.test(previousAssistantMessage.content)
    );
    let reply = socialIntentDetected
      ? "我听到你现在确实想认识一些合适的人。我会根据你持续表达出来的整体感受开始寻找小组。"
      : "我在听。你可以继续告诉我最近的状态、经历和当下的感觉。";

    const currentOptions = context.matchOptions?.options ?? [];
    const numberMatch = /^(?:第)?([一二三123])(?:个)?$/u.exec(normalized);
    const optionNumber = numberMatch
      ? ({ "一": 1, "二": 2, "三": 3, "1": 1, "2": 2, "3": 3 } as const)[numberMatch[1] as "一" | "二" | "三" | "1" | "2" | "3"]
      : null;

    if (normalized.startsWith("[图片观察]")) {
      onboardingTransition = "engaged";
      reply = /建议的追问方向：(.+)/u.exec(normalized)?.[1]?.trim()
        || "你刚发的这些里，哪一件是你自己在做的？";
    } else if (context.onboardingState && /(英文|英语|用 English|use English|speak English|in English)/iu.test(normalized)) {
      onboardingTransition = "language_en";
      reply = "Okay, I'll continue in English. What part of what you just shared feels most representative of you?";
    } else if (context.onboardingState && /(切回中文|用中文|说中文)/u.test(normalized)) {
      onboardingTransition = "language_zh";
      reply = "好，我们继续用中文。你刚才分享的内容里，哪一部分最能代表你？";
    } else if (context.matchRequest?.status === "matching" && context.matchRequest.phase === "push_consent"
      && /(现在|马上|继续|重新|再).*(匹配|找|看看)/u.test(normalized)) {
      actions.push({ type: "activate_match" });
      reply = "好，我现在重新看看当前最合适的人和局。";
    } else if (context.matchRequest?.status === "matching" && context.matchRequest.phase === "push_consent"
      && /(可以|好|愿意|有合适.*推|帮我留意|主动.*告诉)/u.test(normalized)) {
      actions.push({ type: "enable_match_push" });
      reply = "好，有真正合适的人或局时我会主动告诉你。";
    } else if (context.matchRequest?.status === "matching"
      && ["push_consent", "watching"].includes(context.matchRequest.phase)
      && /(不用|不需要|先别|不要推)/u.test(normalized)) {
      actions.push({ type: "disable_match_push" });
      reply = "好，我不会继续主动推送匹配。";
    } else if (context.matchRequest?.status === "matching" && context.matchRequest.phase === "watching"
      && /(现在|马上|再看看|开始匹配|现在匹配)/u.test(normalized)) {
      actions.push({ type: "activate_match" });
      reply = "好，我现在重新看看当前最合适的人和局。";
    } else if (context.onboardingState && !context.onboardingState.imageDeclined
      && /(不想发|不发图|不方便发|不方便.*图片|不要图片)/u.test(normalized)) {
      reply = "好，那就不发。最近你把时间花得最多的一件事是什么？";
    } else if (context.room && context.room.status !== "completed"
      && (/(不参加了|退出(?:这个局|组局|房间)?|我不去了|离开房间|去不了了|没法参加了|取消参加)/u.test(normalized)
        || awaitingRoomExitReason)) {
      const currentUserId = context.matchRequest?.userId;
      const currentMember = context.room.members.find((member) => member.userId === currentUserId);
      const requiresReason = context.room.status === "confirmed" || currentMember?.confirmed === true;
      const reason = extractRoomExitReason(normalized);
      if (requiresReason && !reason) {
        reply = "可以，简单告诉我一个退出原因就行，我记录后帮你退出。";
      } else {
        actions.push({ type: "leave_room", ...(reason ? { reason } : {}) });
        reply = context.matchRequest?.proactivePushEnabled
          ? "好，退出原因已经记录。你会回到留意状态，之后有真正合适的安排时我再告诉你。"
          : "好，退出原因已经记录，这次组局到这里结束。";
      }
    } else if ((context.matchRequest?.status === "cancelled" || context.matchRequest?.status === "expired")
      && /(要|重新找|重新匹配|再来三个|再给我找三个)/u.test(normalized)) {
      actions.push({ type: "restart_match", intent: context.matchRequest.intentSnapshot });
      reply = "好，我重新给你找三个新的。";
    } else if (context.matchRequest?.status === "matching" && /(不去了|取消匹配|先不找了|退出匹配)/u.test(normalized)) {
      actions.push({ type: "cancel_match" });
      reply = "好，我已经帮你退出了。要不要我重新给你找三个新的？";
    } else if (currentOptions.length > 0 && /(都没感觉|换一批|换三个|重新推荐)/u.test(normalized)) {
      actions.push({ type: "refresh_match_options" });
      reply = "好，我换一批新的候选。";
    } else if (currentOptions.length > 0 && optionNumber) {
      actions.push({
        type: "select_match_options",
        preferredOptionNumber: optionNumber,
        acceptedOptionNumbers: [optionNumber],
        requiredHookIds: [],
        rawText: normalized
      });
      reply = "已收到，等待其他人选择。";
    } else if (currentOptions.length > 0 && /3\s*优先[，,、\s]*1\s*(也行|也可以)/u.test(normalized)) {
      actions.push({
        type: "select_match_options",
        preferredOptionNumber: 3,
        acceptedOptionNumbers: [3, 1],
        requiredHookIds: [],
        rawText: normalized
      });
      reply = "已收到，我会优先按第三个、同时保留第一个。";
    } else if (currentOptions.length > 0 && /(都可以|三个都行|随便哪个)/u.test(normalized)) {
      actions.push({
        type: "select_match_options",
        preferredOptionNumber: null,
        acceptedOptionNumbers: currentOptions.map((option) => option.optionNumber as 1 | 2 | 3),
        requiredHookIds: [],
        rawText: normalized
      });
      reply = "已收到，这几个你都可以，我会等待本轮结果。";
    } else if (currentOptions.length > 0) {
      const hook = currentOptions.flatMap((option) => option.hooks.map((item) => ({ option, hook: item })))
        .find(({ hook: item }) => normalized.includes(item.hookText.replace(/[过做并正式参加连续独立]/gu, ""))
          || item.hookText.split(/[，、；]/u).some((part) => part.length >= 3 && normalized.includes(part))
          || ["独立游戏", "游戏", "乐队", "黑客松", "陌生人", "展览"]
            .some((clue) => normalized.includes(clue) && item.hookText.includes(clue)));
      if (hook) {
        actions.push({
          type: "select_match_options",
          preferredOptionNumber: hook.option.optionNumber as 1 | 2 | 3,
          acceptedOptionNumbers: [hook.option.optionNumber as 1 | 2 | 3],
          requiredHookIds: [hook.hook.hookId],
          rawText: normalized
        });
        reply = "已收到，我会把你在意的这个人物线索作为必须条件。";
      }
    }

    if (actions.length === 0 && /我们.*组过乐队/u.test(normalized)
      && !/(我是|我负责|我弹|我唱|我也是成员)/u.test(normalized)) {
      reply = "你也是乐队成员吗？当时负责什么？";
    } else if (userMessageId && /(我是贝斯手|我负责贝斯)/u.test(normalized) && /(上台|演出)/u.test(normalized)) {
      const count = /(?:上台演|上台|演出)(?:过)?([一二两三四五六七八九十\d]+)次/u.exec(normalized)?.[1];
      socialHooks.push({
        hookText: count ? `当过乐队贝斯手并上台演出过${count}次` : "当过乐队贝斯手并正式演出过",
        evidenceMessageIds: [
          ...context.recentMessages
            .filter((message) => message.role === "user" && /我们.*组过乐队/u.test(message.content))
            .map((message) => message.id)
            .slice(-1),
          userMessageId
        ]
      });
    }

    if (actions.length === 0 && context.room?.status === "completed" && /(感觉|反馈|聊得|喜欢|不喜欢|下次|尴尬|开心|一般)/u.test(normalized)) {
      actions.push({
        type: "submit_feedback",
        peopleFeedback: normalized,
        gameFeedback: normalized,
        connectionUserIds: [],
        nextIntent: normalized
      });
      reply = "我记下了这次对人和游戏的感受，也会用它改进下一次匹配。";
    } else if (
      actions.length === 0
      && context.matchOptions
      && /(?:第\s*[一二三123]\s*(?:个|项)?|选项\s*[123]).{0,12}(?:再讲|多讲|详细|什么局|什么活动|介绍)/u.test(normalized)
    ) {
      const matched = /(?:第\s*([一二三123])\s*(?:个|项)?|选项\s*([123]))/u.exec(normalized);
      const raw = matched?.[1] ?? matched?.[2] ?? "1";
      const optionNumber = (raw === "2" || raw === "二" ? 2 : raw === "3" || raw === "三" ? 3 : 1) as 1 | 2 | 3;
      actions.push({ type: "explain_match_option", optionNumber });
      reply = "我根据当前候选事实补充说明。";
    } else if (
      actions.length === 0
      && context.room?.status === "confirming"
      && /(确认|参加|可以去|愿意去|没问题)/u.test(normalized)
    ) {
      actions.push({ type: "confirm_room" });
      reply = "好的，我来为你确认参加。";
    } else if (actions.length === 0 && context.room?.status === "confirmed" && /(结束|完成|参加完|活动完)/u.test(normalized)) {
      actions.push({ type: "complete_room" });
      reply = "收到，我会把这次线下活动标记为已完成。";
    } else if (actions.length === 0 && socialIntentDetected && context.matchRequest?.status !== "matching") {
      actions.push({ type: "start_match", intent: currentIntent ?? { rawText: normalized } });
    } else if (actions.length === 0 && socialIntentDetected && context.matchRequest?.status === "matching") {
      reply = "你的匹配已经在等待中，完成后我会直接在这里告诉你。";
    }

    const queries = mockMemoryQueries(userContent);
    const memories = queries.length && lookupMemories ? await lookupMemories(queries) : [];
    if (memories.length > 0 && actions.length === 0) {
      reply = `${reply}\n\n我也记得：${memories.map((memory) => memory.content).join("；")}`;
    }
    if (
      onboardingTransition === "none"
      && context.onboardingState?.stage === "exploring"
      && !context.onboardingState.boundaryPromptedAt
      && actions.length === 0
      && context.recentMessages.filter((message) => message.role === "user").length >= 2
    ) {
      onboardingTransition = "boundary_prompted";
      reply = context.onboardingState.preferredLanguage === "en"
        ? "One last thing — is there anything you definitely want to avoid, or any social deal-breakers I should know about?"
        : "最后再确认一下，有没有什么雷点，或者明确不想遇到的情况？";
    }
    if (onboardingTransition === "none") {
      onboardingTransition = context.onboardingState && !context.onboardingState.imageDeclined
        && /(不想发|不发图|不方便发|不方便.*图片|不要图片)/u.test(normalized)
        ? "image_declined"
        : context.onboardingState?.stage === "new" || context.onboardingState?.stage === "awaiting_image_or_text"
          ? "engaged"
          : "none";
    }
    return {
      reply,
      onboardingTransition,
      socialIntentDetected,
      currentIntent,
      actions,
      usedMemoryIds: memories.map((memory) => memory.id),
      memoryReviewSuggested: /(忘记|别记|删除|清除|改成|不是)/u.test(userContent),
      socialHooks
    };
  }

  async composeProductMessage(_context: AgentContext, event: AgentProductEvent): Promise<AgentProductMessage> {
    if (event.kind === "match_options") {
      const options = Array.isArray(event.facts.options)
        ? event.facts.options as Array<Record<string, unknown>>
        : [];
      const optionPreviews = options.map((option) => ({
        optionNumber: Number(option.optionNumber),
        text: `${String(option.optionNumber)}｜${String(option.activityName)}\n${String(option.activityDescription)}`
      }));
      const body = optionPreviews.flatMap((option, index) => [
        ...(index > 0 ? ["┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━"] : []),
        ...option.text.split("\n").map((line) => `┃ ${line}`)
      ]);
      return {
        content: [
          "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "┃ TOMEET 组局邀请",
          "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          ...body,
          "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "┃ 回复候选编号或直接告诉我你的选择",
          "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        ].join("\n"),
        optionPreviews
      };
    }
    if (event.kind === "room_intro") {
      const facts = event.facts;
      const activity = facts.activity && typeof facts.activity === "object"
        ? facts.activity as Record<string, unknown>
        : {};
      const confirmedFacts = Array.isArray(facts.confirmedFacts)
        ? facts.confirmedFacts as Array<Record<string, unknown>>
        : [];
      const detailLines = [
        typeof activity.name === "string" ? `活动  ${activity.name}` : null,
        typeof facts.playerCount === "number" ? `👥 人数  ${facts.playerCount} 人` : null,
        typeof facts.meetingPoint === "string" ? `📍 集合  ${facts.meetingPoint}` : null,
        ...confirmedFacts
          .map((fact) => typeof fact.hookText === "string" ? `- ${fact.hookText}` : null)
      ].filter((line): line is string => Boolean(line));
      return {
        content: [
          "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "┃ TOMEET 成局确认函",
          "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          ...detailLines.map((line) => `┃ ${line}`),
          "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        ].join("\n"),
        optionPreviews: []
      };
    }
    const examples: Record<AgentProductEvent["kind"], string> = {
      legacy_match_ready: "匹配已经完成，接下来可以看看这次活动和成员安排。",
      match_options: "候选已经准备好了。",
      match_option_detail: "我根据当前候选事实补充说明这一个选项。",
      match_unavailable: "现在还没有足够合适的人和局。如果你愿意，有合适的出现时我可以主动告诉你。",
      match_confirmation_incomplete: "这次候选没有完成成局确认。你的选择已经收到；如果你愿意，有新的合适安排时我可以主动告诉你。",
      room_intro: "成局信息已经准备好。",
      match_expired: "这次匹配已经超时并结束了。如果还想再匹配，告诉我就行。",
      room_change: "当前活动的信息发生了变化，我把最新情况同步给你。",
      draft_change: "你看过的候选发生了变化，我会按最新情况重新说明。",
      unsupported_channel_message: "这条消息目前无法读取，你可以换一种方式告诉我。",
      channel_media_unreadable: "你发的图片我这边没有取到，可以再发一次吗？",
      action_failed: "刚才那步操作暂时没有完成，你可以稍后再试，或者换一种说法告诉我。"
    };
    return { content: examples[event.kind], optionPreviews: [] };
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
    storagePaths: string[];
    mimeTypes: string[];
    hint?: string;
    preferredLanguage?: AdventurexLanguage;
  }): Promise<Record<string, unknown>> {
    const shared = {
      kind: input.kind,
      summary: input.hint || `用户提供了一份${input.kind === "image" ? "图片" : "短录音"}材料。`,
      recentImpression: input.hint
        ? `用户通过${input.kind === "image" ? "图片" : "录音"}传递的近期印象：${input.hint}`
        : `用户提供了一份${input.kind === "image" ? "视觉" : "声音"}材料。`,
      sources: input.storagePaths,
      mock: true
    };
    // Image observation never carries a reply: the main Agent turn writes the user-facing text.
    return input.kind === "image"
      ? {
          ...shared,
          observableDetails: ["画面里有一个正在进行的现场活动"],
          uncertainty: ["看不出用户本人在其中的角色"],
          personCues: ["用户可能亲自参与了画面里的这件事"],
          suggestedQuestion: "这件事你是去看的，还是自己上手做的？"
        }
      : { ...shared, reply: "我已经理解了这份材料，会把它作为近期印象而不是确定的个人事实。" };
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
