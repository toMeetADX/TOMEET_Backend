import type { MatchCandidate } from "@tomeet/matchmaking";
import type { OfflineGame } from "@tomeet/contracts";
import { createDefaultUserModel } from "@tomeet/user-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedLlmIntelligence } from "./hosted-llm.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hosted vibe matchmaking", () => {
  it("sends continuous multimodal vibe context without any matching tags", async () => {
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          memberIds: ["u1", "u2", "u3"],
          requestIds: ["r1", "r2", "r3"],
          offlineGameId: "game-1",
          summary: "三个人的表达节奏和相处空间能自然形成流动。"
        }) } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const candidates: MatchCandidate[] = ["1", "2", "3"].map((suffix) => {
      const model = createDefaultUserModel(`u${suffix}`);
      model.vibeNarrative = `用户 ${suffix} 的连续整体感觉`;
      model.longTermProfile = { interests: ["不应参与匹配的标签"] };
      model.feedbackMemory = ["不应直接参与匹配的结构化记忆"];
      model.multimodalUnderstanding = {
        image: { vibeNarrative: `用户 ${suffix} 的视觉氛围` }
      };
      return {
        request: {
          requestId: `r${suffix}`,
          userId: `u${suffix}`,
          intentSnapshot: {
            rawText: `用户 ${suffix} 此刻想见人的原话`,
            preferredInterests: ["不应发送"]
          },
          status: "matching" as const,
          roomId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        userModel: model
      };
    });
    const games: OfflineGame[] = [{
      id: "game-1",
      name: "共同散步",
      description: "在真实街区里边走边自然交流",
      minPlayers: 3,
      maxPlayers: 6,
      intentTags: ["不应发送"],
      traits: ["不应发送"],
      requirements: ["可步行一小时"],
      instructions: ["一起选择路线"]
    }];

    const intelligence = new HostedLlmIntelligence({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      textModel: "multimodal-model",
      visionModel: "multimodal-model",
      audioModel: "audio-model"
    });
    await intelligence.decide(candidates, games, "r1");

    const payload = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
    const matchingInput = payload.messages[1]!.content;
    expect(matchingInput).toContain("vibeNarrative");
    expect(matchingInput).toContain("multimodalVibes");
    expect(matchingInput).toContain("currentVibe");
    expect(matchingInput).not.toContain("intentTags");
    expect(matchingInput).not.toContain("traits");
    expect(matchingInput).not.toContain("longTermProfile");
    expect(matchingInput).not.toContain("feedbackMemory");
    expect(matchingInput).not.toContain("preferredInterests");
    expect(matchingInput).not.toContain("不应发送");
  });
});
