import type {
  AgentContext,
  AgentIntelligence,
  ConversationInsight,
  FeedbackInsight
} from "@tomeet/agent-core";
import {
  matchDecisionSchema,
  type MatchDecision,
  type Message,
  type OfflineGame,
  type PostEventFeedback,
  type UserModel
} from "@tomeet/contracts";
import type { MatchCandidate, MatchmakingIntelligence } from "@tomeet/matchmaking";
import { z } from "zod";

const conversationInsightSchema = z.object({
  reply: z.string().min(1).max(4000),
  socialIntentDetected: z.boolean(),
  vibeNarrative: z.string().min(1).max(12_000),
  interests: z.array(z.string()).max(20),
  longTermProfilePatch: z.record(z.unknown()),
  currentIntent: z.record(z.unknown()).optional(),
  actions: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("start_match"), intent: z.record(z.unknown()) }),
    z.object({ type: z.literal("confirm_room") }),
    z.object({ type: z.literal("complete_room") }),
    z.object({
      type: z.literal("submit_feedback"),
      peopleFeedback: z.string().min(1),
      gameFeedback: z.string().min(1),
      connectionUserIds: z.array(z.string()),
      nextIntent: z.string().min(1)
    })
  ])).max(2)
});

const feedbackInsightSchema = z.object({
  memory: z.string().min(1).max(4_000),
  vibeNarrative: z.string().min(1).max(12_000),
  longTermProfilePatch: z.record(z.unknown()),
  currentIntent: z.record(z.unknown())
});

const multimodalInsightSchema = z.object({
  reply: z.string().min(1).max(4_000),
  summary: z.string().min(1).max(4_000),
  vibeNarrative: z.string().min(1).max(12_000),
  longTermProfilePatch: z.record(z.unknown())
}).passthrough();

export interface HostedLlmOptions {
  apiKey: string;
  baseUrl: string;
  textModel: string;
  visionModel?: string;
  audioModel: string;
}

export class HostedLlmIntelligence implements AgentIntelligence, MatchmakingIntelligence {
  constructor(private readonly options: HostedLlmOptions) {}

  private async chatJson(system: string, content: unknown, model = this.options.textModel): Promise<unknown> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content }
        ]
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`LLM 请求失败 (${response.status}): ${await response.text()}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("LLM 未返回内容");
    const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(normalized);
  }

  private async parseOrRepair<T>(
    schema: z.ZodType<T>,
    result: unknown,
    contract: string,
    source: unknown,
    model = this.options.textModel
  ): Promise<T> {
    let candidate = result;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) return parsed.data;
      candidate = await this.chatJson(
        [
          "你是 JSON 契约修复器。只修复结构和与状态冲突的 action，不新增没有证据的动作。",
          contract,
          "必须补齐必填字段、删除多余嵌套并只输出合法 JSON。"
        ].join("\n"),
        JSON.stringify({
          invalidOutput: candidate,
          validationIssues: parsed.error.issues,
          source
        }),
        model
      );
    }
    return schema.parse(candidate);
  }

  async reply(context: AgentContext, userContent: string): Promise<ConversationInsight> {
    const result = await this.chatJson(
      [
        "你是 TOMEET，一个能长期认识用户的社交 Agent。",
        "你对用户的理解必须是一段连续、细腻、可更新的 vibeNarrative，不要把人拆成兴趣标签、性格类型、关键词列表或打分维度。",
        "vibeNarrative 要综合表达方式、叙事节奏、当下状态、互动能量、生活场景与多模态材料带来的整体感觉；只写有证据的内容，不推断敏感属性。",
        "longTermProfilePatch 只用于非匹配业务的稳定事实记录；不要输出标签数组，interests 固定输出空数组。匹配系统不会读取 longTermProfilePatch。",
        "用户说“我想认识一些人”“最近想找搭子”“想参加活动”“帮我匹配”“想认识同好”都属于已经明确表达当前社交意图：socialIntentDetected=true，并输出 start_match。不要再反问他是否要开始。",
        "只有假设、将来可能、泛泛讨论社交，或只是说喜欢某个兴趣而没有想认识人的表达，socialIntentDetected 才为 false。",
        "回复自然、克制，不虚构尚未发生的匹配或状态变化。所有产品操作必须通过 actions 输出，由系统执行。",
        "可用 action：start_match、confirm_room、complete_room、submit_feedback。没有操作时 actions=[]。",
        "只有用户明确表达现在想社交，且没有等待中的请求或未结束房间时，才输出 start_match，并把本次意图放入 intent。",
        "只有用户明确接受当前 confirming 房间时才输出 confirm_room。",
        "只有用户明确表示线下活动已经结束，且当前房间 confirmed 时才输出 complete_room。",
        "只有当前房间 completed 且用户表达了活动感受时才输出 submit_feedback，分别整理 peopleFeedback、gameFeedback 和 nextIntent。",
        "不要猜测 connectionUserIds；只有用户明确指向房间成员且能够确定 ID 时才填写，否则用空数组。",
        "currentIntent 必须是 JSON 对象，actions 必须是 JSON 对象数组，绝不能把它们写成字符串。",
        "start_match 的严格格式示例：{\"reply\":\"好，我开始感受谁和你会自然同频。\",\"socialIntentDetected\":true,\"vibeNarrative\":\"一段连续自然语言描述\",\"interests\":[],\"currentIntent\":{\"rawText\":\"用户原话\"},\"actions\":[{\"type\":\"start_match\",\"intent\":{\"rawText\":\"用户原话\"}}]}。",
        "没有动作时严格使用 actions:[]。只输出 JSON，不要输出解释。"
      ].join("\n"),
      JSON.stringify({
        recentMessages: context.recentMessages.slice(-20),
        rollingSummary: context.rollingSummary,
        currentVibeNarrative: context.userModel.vibeNarrative,
        multimodalVibes: extractMultimodalVibes(context.userModel),
        currentIntent: context.userModel.currentIntent,
        relevantFeedback: context.relevantFeedback,
        relevantMatches: context.relevantMatches,
        latestMatchRequest: context.matchRequest,
        latestRoom: context.room,
        newMessage: userContent
      })
    );
    const actionPolicy = context.room?.status === "confirming"
      ? "当前只允许 actions=[] 或 confirm_room；禁止 complete_room 和 submit_feedback。"
      : context.room?.status === "confirmed"
        ? "当前只允许 actions=[] 或 complete_room；禁止 confirm_room 和 submit_feedback。"
        : context.room?.status === "completed"
          ? "当前只允许 actions=[] 或 submit_feedback；禁止 confirm_room 和 complete_room。"
          : context.matchRequest?.status === "matching"
            ? "已有等待中的匹配请求，actions 必须为空。"
            : "没有活动房间时，只允许 actions=[] 或 start_match。";
    const insight = await this.parseOrRepair(
      conversationInsightSchema,
      result,
      [
        "输出字段：reply, socialIntentDetected, vibeNarrative, interests, longTermProfilePatch, currentIntent, actions。",
        "actions 只能是 start_match(intent)、confirm_room、complete_room、submit_feedback(peopleFeedback, gameFeedback, connectionUserIds, nextIntent)。",
        "如果 type=submit_feedback，peopleFeedback、gameFeedback、connectionUserIds、nextIntent 必须与 action 同级。",
        actionPolicy
      ].join("\n"),
      { newMessage: userContent, roomStatus: context.room?.status ?? null }
    );
    if (insight.actions.some((action) => !isActionAllowed(action.type, context))) {
      const corrected = await this.chatJson(
        [
          "修正 TOMEET 的 actions，其他字段保持原意。",
          actionPolicy,
          "用户没有明确触发允许的动作时使用 actions=[]。只输出完整 JSON。"
        ].join("\n"),
        JSON.stringify({ output: insight, newMessage: userContent })
      );
      return conversationInsightSchema.parse(corrected);
    }
    return insight;
  }

  async summarizeConversation(previousSummary: string, messages: Message[]): Promise<string> {
    if (messages.length === 0) return previousSummary;
    const result = await this.chatJson(
      [
        "把长期对话压缩成滚动摘要，保留用户明确表达的稳定偏好、重要状态变化、已确认的社交意图和未完成事项。",
        "不要编造，不要保留无关寒暄，不要输出敏感属性推断。",
        "合并 previousSummary 与 newMessages，只输出 JSON：{\"summary\":\"...\"}，摘要最多 6000 字。"
      ].join("\n"),
      JSON.stringify({ previousSummary, newMessages: messages })
    );
    return (await this.parseOrRepair(
      z.object({ summary: z.string().min(1).max(6_000) }),
      result,
      "只输出 {summary:string}。",
      { previousSummary, newMessages: messages }
    )).summary;
  }

  async understandMultimodal(input: {
    kind: "image" | "audio";
    storagePath: string;
    mimeType: string;
    hint?: string;
  }): Promise<Record<string, unknown>> {
    if (input.kind === "image") {
      const result = await this.chatJson(
        [
          "理解用户主动提供的图片，感受画面选择、氛围、关系距离、生活痕迹和表达方式。避免敏感属性推断。",
          "不要输出标签、关键词列表、性格分类或分数。把视觉信息融入一段连续的 vibeNarrative。",
          "输出 JSON，必须包含 reply、summary、vibeNarrative、longTermProfilePatch；interests 或标签数组一律不要生成。"
        ].join("\n"),
        [
          { type: "text", text: input.hint || "请理解这张图片与用户偏好的关系" },
          { type: "image_url", image_url: { url: input.storagePath } }
        ],
        this.options.visionModel ?? this.options.textModel
      );
      return this.parseOrRepair(
        multimodalInsightSchema,
        result,
        "只输出 reply, summary, vibeNarrative, longTermProfilePatch。",
        { kind: input.kind, hint: input.hint },
        this.options.visionModel ?? this.options.textModel
      );
    }

    const audioResponse = await fetch(input.storagePath, { signal: AbortSignal.timeout(30_000) });
    if (!audioResponse.ok) throw new Error("无法读取短录音");
    const form = new FormData();
    form.set("model", this.options.audioModel);
    form.set("file", new File([await audioResponse.blob()], "voice.webm", { type: input.mimeType }));
    const transcriptResponse = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000)
    });
    if (!transcriptResponse.ok) throw new Error(`音频转写失败 (${transcriptResponse.status})`);
    const transcript = await transcriptResponse.json() as { text?: string };
    const result = await this.chatJson(
      [
        "理解用户短录音的内容、语气、停顿、表达节奏与当下能量。不要推断敏感属性。",
        "不要输出标签、关键词列表、性格分类或分数。把声音和内容融入连续的 vibeNarrative。",
        "输出 JSON，必须包含 reply、summary、vibeNarrative、longTermProfilePatch。"
      ].join("\n"),
      JSON.stringify({ transcript: transcript.text ?? "", hint: input.hint })
    );
    return {
      transcript: transcript.text ?? "",
      ...await this.parseOrRepair(
        multimodalInsightSchema,
        result,
        "只输出 reply, summary, vibeNarrative, longTermProfilePatch。",
        { transcript: transcript.text ?? "", hint: input.hint }
      )
    };
  }

  async reflectOnFeedback(feedback: PostEventFeedback, userModel: UserModel): Promise<FeedbackInsight> {
    const result = await this.chatJson(
      [
        "整理一次线下社交活动后的反馈，用于长期认识用户。",
        "memory 是简洁、忠实的反馈记忆；vibeNarrative 是结合既有叙事和本次真实体验后更新的一段连续整体描述；currentIntent 表示用户下一次明确期待。",
        "不要输出标签、类型、关键词数组或分数，不要推断敏感属性。只输出 JSON：memory, vibeNarrative, longTermProfilePatch, currentIntent。"
      ].join("\n"),
      JSON.stringify({ feedback, currentVibeNarrative: userModel.vibeNarrative })
    );
    return this.parseOrRepair(
      feedbackInsightSchema,
      result,
      "只输出 memory, vibeNarrative, longTermProfilePatch, currentIntent。",
      { feedback, currentVibeNarrative: userModel.vibeNarrative }
    );
  }

  async decide(candidates: MatchCandidate[], games: OfflineGame[], requiredRequestId?: string): Promise<MatchDecision | null> {
    if (candidates.length < 3) return null;
    const matchingInput = {
      requiredRequestId,
      candidates: candidates.map(({ request, userModel }) => ({
        requestId: request.requestId,
        userId: request.userId,
        currentVibe: typeof request.intentSnapshot.rawText === "string" ? request.intentSnapshot.rawText : "",
        vibeNarrative: userModel.vibeNarrative,
        multimodalVibes: extractMultimodalVibes(userModel)
      })),
      games: games.map((game) => ({
        id: game.id,
        name: game.name,
        description: game.description,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        requirements: game.requirements,
        instructions: game.instructions
      }))
    };
    const result = await this.chatJson(
      [
        "你负责 TOMEET 线下社交的纯 vibe 匹配。只能选择输入中的等待用户和已有游戏。",
        "requiredRequestId 是触发本次匹配的请求，输出的 requestIds 必须包含它，对应的用户也必须包含在 memberIds。",
        "选择 3–10 人。只根据每个人的连续自然语言 vibeNarrative、当下原话 currentVibe 和多模态叙事 multimodalVibes 判断相处是否自然。",
        "严禁使用兴趣标签重合、intentTags、traits、性格分类、人口属性、关键词计数、向量标签或任何打分维度。不要因为提到相同名词就判定合适。",
        "关注表达节奏、能量互补、关系距离、好奇心方向、线下相处画面与潜在互动流动；不要推断敏感属性。",
        "输入已有至少 3 位候选人时必须给出一个 3–10 人的小组，memberIds 与 requestIds 数量必须相同且按同一顺序一一对应，不能只返回触发用户。",
        "游戏人数必须覆盖成员数。只输出 JSON：memberIds, requestIds, offlineGameId, summary。"
      ].join("\n"),
      JSON.stringify(matchingInput)
    );
    return this.parseOrRepair(
      matchDecisionSchema,
      result,
      "只输出 memberIds, requestIds, offlineGameId, summary；必须选择 3–10 人，成员与请求数量相同、顺序一一对应，并包含 requiredRequestId。",
      matchingInput
    );
  }
}

function extractMultimodalVibes(userModel: UserModel): string[] {
  return Object.values(userModel.multimodalUnderstanding)
    .flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const vibe = typeof record.vibeNarrative === "string" ? record.vibeNarrative : undefined;
      const summary = typeof record.summary === "string" ? record.summary : undefined;
      const transcript = typeof record.transcript === "string" ? record.transcript : undefined;
      return [vibe ?? summary, transcript].filter((item): item is string => Boolean(item));
    })
    .slice(-12);
}

function isActionAllowed(
  type: "start_match" | "confirm_room" | "complete_room" | "submit_feedback",
  context: AgentContext
): boolean {
  if (context.room?.status === "confirming") return type === "confirm_room";
  if (context.room?.status === "confirmed") return type === "complete_room";
  if (context.room?.status === "completed") return type === "submit_feedback";
  if (context.matchRequest?.status === "matching") return false;
  return type === "start_match";
}
