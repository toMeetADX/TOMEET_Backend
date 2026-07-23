import { describe, expect, it } from "vitest";
import { createDefaultUserModel } from "@tomeet/user-model";
import {
  buildAgentContext,
  estimateTokens,
  MockAgentIntelligence,
  sanitizeMemoryCandidates,
  selectRelevantMemories
} from "./index.js";

describe("mock agent intelligence", () => {
  it("only detects explicit social intent", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = buildAgentContext([], createDefaultUserModel("u1"));
    expect((await intelligence.reply(context, "我喜欢摄影")).socialIntentDetected).toBe(false);
    const social = await intelligence.reply(context, "我想参加活动认识一些喜欢摄影的人");
    expect(social.socialIntentDetected).toBe(true);
    expect(social.actions[0]?.type).toBe("start_match");
  });

  it("summarizes old messages and reflects feedback", async () => {
    const intelligence = new MockAgentIntelligence();
    const summary = await intelligence.summarizeConversation("用户喜欢摄影", [{
      id: "m1",
      userId: "u1",
      role: "user",
      content: "最近也开始徒步",
      createdAt: new Date().toISOString()
    }]);
    expect(summary).toContain("最近也开始徒步");

    const reflection = await intelligence.reflectOnFeedback({
      userId: "u1",
      roomId: "room-1",
      peopleFeedback: "小组交流很自然",
      gameFeedback: "故事卡比竞技游戏舒服",
      connectionUserIds: [],
      nextIntent: "下次继续小组深聊"
    }, createDefaultUserModel("u1"));
    expect(reflection.currentIntent.nextIntent).toContain("小组深聊");
  });

  it("excludes the current user message and bounds every historical context section", () => {
    const now = new Date().toISOString();
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `m-${index}`,
      userId: "u1",
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `第 ${index} 条消息 ${"很长的上下文".repeat(100)}`,
      createdAt: now
    }));
    const model = createDefaultUserModel("u1");
    const context = buildAgentContext(messages, model, {
      checkpoint: "旧 checkpoint ".repeat(1_000),
      excludeMessageId: "m-39"
    });
    expect(context.recentMessages.length).toBeGreaterThan(0);
    expect(context.recentMessages.length).toBeLessThanOrEqual(15);
    expect(context.recentMessages.some((message) => message.id === "m-39")).toBe(false);
    expect(estimateTokens(context.checkpoint)).toBeLessThanOrEqual(1_001);
    expect(context.budget.recentMessageTokens).toBeLessThanOrEqual(4_000);
    expect(context.budget.totalEstimatedTokens).toBeLessThanOrEqual(12_000);
  });

  it("rejects sensitive candidates and retrieves only bounded active memories", () => {
    const sanitized = sanitizeMemoryCandidates([
      {
        kind: "stable_fact",
        stableKey: "email",
        content: "我的邮箱是 person@example.com",
        expiresAt: null
      },
      {
        kind: "preference",
        stableKey: "coffee",
        content: "用户明确喜欢安静的咖啡馆",
        expiresAt: null
      }
    ], "message");
    expect(sanitized.rejectedCount).toBe(1);
    expect(sanitized.accepted).toHaveLength(1);

    const memory = {
      id: "memory-1",
      userId: "u1",
      kind: "preference" as const,
      stableKey: "coffee",
      content: "用户明确喜欢安静的咖啡馆",
      sourceType: "message" as const,
      sourceId: "message-1",
      explicitness: "explicit" as const,
      status: "active" as const,
      supersededBy: null,
      confirmationCount: 2,
      usageCount: 0,
      lastConfirmedAt: nowIso(),
      lastUsedAt: null,
      expiresAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    expect(selectRelevantMemories([memory], ["咖啡馆"], 6)).toHaveLength(1);
  });
});

function nowIso(): string {
  return new Date().toISOString();
}
