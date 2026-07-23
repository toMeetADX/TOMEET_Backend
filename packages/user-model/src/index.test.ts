import { describe, expect, it } from "vitest";
import {
  applyConversationInsight,
  applyMultimodalInsight,
  applyPostEventFeedback,
  createDefaultUserModel
} from "./index.js";

describe("user model", () => {
  it("does not write Agent-generated profile fields into the legacy model", () => {
    const initial = createDefaultUserModel("u1");
    const next = applyConversationInsight(initial, { interests: ["徒步", "徒步", "摄影"] });
    expect(next.longTermProfile.interests).toEqual([]);
    expect(next.version).toBe(1);
  });

  it("replaces current intent without coupling the reply to profile mutations", () => {
    const initial = createDefaultUserModel("u1");
    initial.currentIntent = { rawText: "旧意图", preferredSize: 8 };
    initial.longTermProfile = { interests: ["徒步"], interactionStyle: { pace: "慢" } };
    const next = applyConversationInsight(initial, {
      interests: ["摄影"],
      vibeNarrative: "说话有留白，喜欢从共同观察里自然靠近别人。",
      longTermProfilePatch: { interactionStyle: { depth: "深入" } },
      currentIntent: { rawText: "这次想认识摄影同好" }
    });
    expect(next.longTermProfile).toEqual({
      interests: ["徒步"],
      interactionStyle: { pace: "慢" }
    });
    expect(next.currentIntent).toEqual({ rawText: "这次想认识摄影同好" });
    expect(next.vibeNarrative).toBe("");
  });

  it("keeps multimodal observations bounded and leaves durable memory to the memory layer", () => {
    const initial = createDefaultUserModel("u1");
    const multimodal = applyMultimodalInsight(initial, "input-1", {
      summary: "用户经常拍城市建筑",
      vibeNarrative: "会注意城市里容易被忽略的细节，表达安静但有持续好奇。",
      longTermProfilePatch: { interests: ["建筑摄影"] }
    });
    const feedback = applyPostEventFeedback(multimodal, {
      userId: "u1",
      roomId: "room-1",
      peopleFeedback: "更喜欢小组交流",
      gameFeedback: "安静的故事卡更自然",
      connectionUserIds: [],
      nextIntent: "下次想要四人深聊"
    }, { currentIntent: { rawText: "四人深聊" } });
    expect(feedback.longTermProfile).toEqual(initial.longTermProfile);
    expect(feedback.currentIntent).toEqual({ rawText: "四人深聊" });
    expect(feedback.vibeNarrative).toBe("");
    expect(feedback.feedbackMemory[0]).toContain("更喜欢小组交流");
    expect(feedback.multimodalUnderstanding["input-1"]).not.toHaveProperty("longTermProfilePatch");
    expect(feedback.multimodalUnderstanding["input-1"]).not.toHaveProperty("vibeNarrative");
  });
});
