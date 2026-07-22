import type {
  MatchRequest,
  MatchRoom,
  Message,
  PostEventFeedback,
  UserModel,
  WebSearchMeta
} from "@tomeet/contracts";

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

export interface AgentContext {
  recentMessages: Message[];
  rollingSummary: string;
  userModel: UserModel;
  relevantFeedback: string[];
  relevantMatches: string[];
  matchRequest: MatchRequest | null;
  room: MatchRoom | null;
}

export interface ConversationInsight {
  reply: string;
  socialIntentDetected: boolean;
  vibeNarrative: string;
  interests: string[];
  longTermProfilePatch?: Record<string, unknown>;
  currentIntent?: Record<string, unknown>;
  actions: AgentAction[];
  webSearch?: WebSearchMeta;
}

export interface FeedbackInsight {
  memory: string;
  vibeNarrative: string;
  longTermProfilePatch: Record<string, unknown>;
  currentIntent: Record<string, unknown>;
}

export interface AgentIntelligence {
  reply(context: AgentContext, userContent: string): Promise<ConversationInsight>;
  summarizeConversation(previousSummary: string, messages: Message[]): Promise<string>;
  understandMultimodal(input: {
    kind: "image" | "audio";
    storagePath: string;
    mimeType: string;
    hint?: string;
  }): Promise<Record<string, unknown>>;
  reflectOnFeedback(feedback: PostEventFeedback, userModel: UserModel): Promise<FeedbackInsight>;
}

const socialIntentPatterns = [
  /想(认识|结识|找|约|参加).{0,12}(朋友|人|活动|局)/u,
  /想.{0,8}(社交|线下见面|一起玩)/u,
  /(组个局|找搭子|约活动|参加活动)/u,
  /(meet|hang out|make friends|socialize)/iu
];

export class MockAgentIntelligence implements AgentIntelligence {
  async reply(context: AgentContext, userContent: string): Promise<ConversationInsight> {
    const socialIntentDetected = socialIntentPatterns.some((pattern) => pattern.test(userContent));
    const currentIntent = socialIntentDetected
      ? {
          expressedAt: new Date().toISOString(),
          rawText: userContent
        }
      : undefined;
    const vibeNarrative = [context.userModel.vibeNarrative, `用户最近表达：${userContent}`]
      .filter(Boolean)
      .join("\n")
      .slice(-12_000);

    const actions: AgentAction[] = [];
    const normalized = userContent.trim();
    let reply = socialIntentDetected
      ? "我听到你现在确实想认识一些合适的人。我会根据你持续表达出来的整体感觉开始寻找小组。"
      : "我在听。你可以继续告诉我最近的状态、经历和当下的感觉。";

    if (context.room?.status === "completed" && /(感觉|反馈|聊得|喜欢|不喜欢|下次|尴尬|开心|一般)/u.test(normalized)) {
      actions.push({
        type: "submit_feedback",
        peopleFeedback: normalized,
        gameFeedback: normalized,
        connectionUserIds: [],
        nextIntent: normalized
      });
      reply = "我记下了这次对人和游戏的感受，也会把你对下一次的期待更新到长期理解里。";
    } else if (context.room?.status === "confirming" && /(确认|参加|可以去|愿意去|没问题)/u.test(normalized)) {
      actions.push({ type: "confirm_room" });
      reply = "好的，我来为你确认参加。等所有成员确认后，这个房间就正式成立。";
    } else if (context.room?.status === "confirmed" && /(结束|完成|参加完|活动完)/u.test(normalized)) {
      actions.push({ type: "complete_room" });
      reply = "收到，我会把这次线下活动标记为已完成。你可以直接告诉我对这群人和游戏的真实感受。";
    } else if (socialIntentDetected && context.matchRequest?.status !== "matching") {
      actions.push({ type: "start_match", intent: currentIntent ?? { rawText: normalized } });
    } else if (socialIntentDetected && context.matchRequest?.status === "matching") {
      reply = "你的匹配已经在等待中。我会继续寻找合适的人，匹配完成后会直接在这里告诉你。";
    }

    return {
      reply,
      socialIntentDetected,
      vibeNarrative,
      interests: [],
      longTermProfilePatch: {},
      currentIntent,
      actions
    };
  }

  async summarizeConversation(previousSummary: string, messages: Message[]): Promise<string> {
    const additions = messages
      .map((message) => `${message.role === "user" ? "用户" : "Agent"}：${message.content}`)
      .join("\n");
    return [previousSummary, additions].filter(Boolean).join("\n").slice(-6_000);
  }

  async understandMultimodal(input: {
    kind: "image" | "audio";
    storagePath: string;
    mimeType: string;
    hint?: string;
  }): Promise<Record<string, unknown>> {
    const vibeNarrative = input.hint
      ? `用户通过${input.kind === "image" ? "图片" : "录音"}传递的感觉：${input.hint}`
      : `用户提供了一段${input.kind === "image" ? "视觉" : "声音"}材料。`;
    return {
      kind: input.kind,
      summary: input.hint || `已接收${input.kind === "image" ? "图片" : "短录音"}，等待接入真实多模态模型后生成详细理解。`,
      vibeNarrative,
      source: input.storagePath,
      mock: true,
      longTermProfilePatch: {}
    };
  }

  async reflectOnFeedback(feedback: PostEventFeedback, _userModel: UserModel): Promise<FeedbackInsight> {
    return {
      memory: `人群：${feedback.peopleFeedback}；游戏：${feedback.gameFeedback}；下次：${feedback.nextIntent}`,
      vibeNarrative: [
        _userModel.vibeNarrative,
        `这次线下相处后，用户觉得：${feedback.peopleFeedback}；对共同体验的感受是：${feedback.gameFeedback}；下一次期待：${feedback.nextIntent}`
      ].filter(Boolean).join("\n").slice(-12_000),
      longTermProfilePatch: {
        socialPreferences: {
          people: feedback.peopleFeedback,
          offlineGame: feedback.gameFeedback
        }
      },
      currentIntent: { nextIntent: feedback.nextIntent }
    };
  }
}

export function buildAgentContext(
  messages: Message[],
  userModel: UserModel,
  socialState: {
    matchRequest?: MatchRequest | null;
    room?: MatchRoom | null;
    rollingSummary?: string;
  } = {}
): AgentContext {
  return {
    recentMessages: messages.slice(-20),
    rollingSummary: socialState.rollingSummary
      ?? messages.slice(0, -20).map((message) => message.content).join(" ").slice(-2_000),
    userModel,
    relevantFeedback: userModel.feedbackMemory.slice(-10),
    relevantMatches: userModel.socialHistory.slice(-10),
    matchRequest: socialState.matchRequest ?? null,
    room: socialState.room ?? null
  };
}
