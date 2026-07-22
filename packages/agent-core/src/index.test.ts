import { describe, expect, it } from "vitest";
import { createDefaultUserModel } from "@tomeet/user-model";
import { MockAgentIntelligence } from "./index.js";

describe("mock agent intelligence", () => {
  it("only detects explicit social intent", async () => {
    const intelligence = new MockAgentIntelligence();
    const context = {
      recentMessages: [],
      rollingSummary: "",
      userModel: createDefaultUserModel("u1"),
      relevantFeedback: [],
      relevantMatches: [],
      matchRequest: null,
      room: null
    };
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
    expect(reflection.longTermProfilePatch).toHaveProperty("socialPreferences");
    expect(reflection.currentIntent.nextIntent).toContain("小组深聊");
  });
});
