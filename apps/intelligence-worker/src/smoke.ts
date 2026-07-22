import { resolve } from "node:path";
import { config } from "dotenv";
import { HostedLlmIntelligence } from "@tomeet/intelligence";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

const apiKey = process.env.LLM_API_KEY;
const textModel = process.env.LLM_TEXT_MODEL;
if (!apiKey || !textModel) throw new Error("缺少 LLM_API_KEY 或 LLM_TEXT_MODEL");

const intelligence = new HostedLlmIntelligence({
  apiKey,
  baseUrl: process.env.LLM_API_BASE_URL ?? "https://api.siliconflow.cn/v1",
  textModel,
  visionModel: process.env.LLM_VISION_MODEL ?? textModel,
  audioModel: process.env.LLM_AUDIO_MODEL ?? "whisper-1"
});

const baseContext = {
  recentMessages: [],
  rollingSummary: "",
  userModel: {
    userId: "00000000-0000-4000-8000-000000000001",
    vibeNarrative: "表达克制但好奇，喜欢通过真实场景慢慢建立连接，在线下更在意自然流动而不是快速破冰。",
    longTermProfile: { interests: ["摄影", "咖啡"] },
    currentIntent: {},
    socialHistory: [],
    feedbackMemory: [],
    multimodalUnderstanding: {},
    version: 0,
    updatedAt: new Date().toISOString()
  },
  relevantFeedback: [],
  relevantMatches: [],
  matchRequest: null,
  room: null
};

const start = await intelligence.reply(
  baseContext,
  "我最近想认识一些也喜欢摄影的人，希望第一次见面不要太尴尬。"
);
if (start.actions[0]?.type !== "start_match") throw new Error("真实模型未识别 start_match");

const room = {
  roomId: "30000000-0000-4000-8000-000000000001",
  members: [
    { userId: baseContext.userModel.userId, displayName: "测试用户", confirmed: false },
    { userId: "30000000-0000-4000-8000-000000000002", displayName: "林知夏", confirmed: true },
    { userId: "30000000-0000-4000-8000-000000000003", displayName: "陈屿", confirmed: true }
  ],
  offlineGame: {
    id: "game-story-table",
    name: "故事交换桌",
    description: "通过故事卡自然交流",
    minPlayers: 3,
    maxPlayers: 6,
    intentTags: ["轻松认识"],
    traits: ["低压力"],
    requirements: [],
    instructions: []
  },
  matchSummary: "共同喜欢摄影，交流氛围轻松",
  status: "confirming" as const,
  createdAt: new Date().toISOString(),
  completedAt: null
};

const confirm = await intelligence.reply({ ...baseContext, room }, "确认参加，没问题");
if (confirm.actions[0]?.type !== "confirm_room") throw new Error("真实模型未识别 confirm_room");

const complete = await intelligence.reply(
  { ...baseContext, room: { ...room, status: "confirmed" as const, members: room.members.map((member) => ({ ...member, confirmed: true })) } },
  "活动已经结束了"
);
if (complete.actions[0]?.type !== "complete_room") throw new Error("真实模型未识别 complete_room");

const feedback = await intelligence.reply(
  { ...baseContext, room: { ...room, status: "completed" as const, completedAt: new Date().toISOString() } },
  "大家相处很自然，游戏也不尴尬，下次我想参加人数更少、交流更深的活动"
);
if (feedback.actions[0]?.type !== "submit_feedback") throw new Error("真实模型未识别 submit_feedback");
const feedbackInsight = await intelligence.reflectOnFeedback({
  userId: baseContext.userModel.userId,
  roomId: room.roomId,
  peopleFeedback: "大家相处很自然",
  gameFeedback: "故事卡让交流不尴尬",
  connectionUserIds: [],
  nextIntent: "下次想参加人数更少、交流更深的活动"
}, baseContext.userModel);
if (!feedbackInsight.memory || !feedbackInsight.vibeNarrative) {
  throw new Error("真实模型未完成反馈整理或 vibe 更新");
}

const now = new Date().toISOString();
const candidates = Array.from({ length: 5 }, (_, index) => {
  const suffix = String(index + 1).padStart(12, "0");
  const userId = `40000000-0000-4000-8000-${suffix}`;
  const requestId = `50000000-0000-4000-8000-${suffix}`;
  return {
    request: {
      requestId,
      userId,
      intentSnapshot: { rawText: index === 4 ? "想认识摄影同好" : "想轻松认识新朋友" },
      status: "matching" as const,
      roomId: null,
      createdAt: now,
      updatedAt: now
    },
    userModel: {
      ...baseContext.userModel,
      userId,
      vibeNarrative: index === 4
        ? "观察细腻，愿意先共同做一件事再自然打开话题，偏好有空间感的相处。"
        : `第 ${index + 1} 位用户的表达有自己的节奏，愿意在共同体验中自然回应他人。`,
      longTermProfile: { interests: index === 4 ? ["摄影"] : ["咖啡", "徒步"] }
    }
  };
});
const requiredRequestId = candidates[4]!.request.requestId;
const decision = await intelligence.decide(candidates, [room.offlineGame], requiredRequestId);
if (!decision?.requestIds.includes(requiredRequestId)) throw new Error("真实模型匹配遗漏触发用户");

console.log(JSON.stringify({
  model: textModel,
  valid: true,
  actions: [start.actions[0].type, confirm.actions[0].type, complete.actions[0].type, feedback.actions[0].type],
  matchmakingIncludesRequester: true,
  sampleReply: start.reply
}, null, 2));
