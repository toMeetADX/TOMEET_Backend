import { randomUUID } from "node:crypto";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { MemoryStore } from "@tomeet/data";
import { JobProcessor } from "@tomeet/intelligence";
import { MockMatchmakingIntelligence } from "@tomeet/matchmaking";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];

function setup() {
  const store = new MemoryStore({ seedDemoData: true });
  const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence());
  const app = buildApp({ store, inlineProcessor: processor });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("TOMEET core flow", () => {
  it("runs the complete social flow using conversation only", async () => {
    const { app } = setup();
    const userId = randomUUID();
    const send = (content: string) => app.inject({
      method: "POST",
      url: "/agent/messages",
      payload: { userId, displayName: "安然", content, idempotencyKey: randomUUID() }
    });

    const socialResponse = await send("我想认识一些喜欢摄影的人，轻松自然一点");
    expect(socialResponse.statusCode).toBe(200);
    const socialResult = socialResponse.json().job.result;
    expect(socialResult.socialIntentDetected).toBe(true);
    expect(socialResult.actions[0].type).toBe("start_match");

    const requestId = socialResult.actions[0].matchRequest.requestId as string;
    const requestResponse = await app.inject({ method: "GET", url: `/match-requests/${requestId}` });
    const roomId = requestResponse.json().matchRequest.roomId as string;
    expect(roomId).toBeTruthy();

    const duplicateRoomMatch = await app.inject({
      method: "POST",
      url: "/match-requests",
      payload: { userId, intent: { rawText: "再匹配一组" } }
    });
    expect(duplicateRoomMatch.statusCode).toBe(409);

    const historyResponse = await app.inject({ method: "GET", url: `/agent/messages/${userId}` });
    expect(historyResponse.json().messages.some((message: { content: string }) => message.content.includes("匹配完成了"))).toBe(true);

    const confirmResponse = await send("确认参加，没问题");
    expect(confirmResponse.json().job.result.actions[0].room.status).toBe("confirmed");

    const completeResponse = await send("活动已经结束了");
    expect(completeResponse.json().job.result.actions[0].room.status).toBe("completed");
    const completedModel = await app.inject({ method: "GET", url: `/users/${userId}/model` });
    expect(completedModel.json().userModel.currentIntent).toEqual({});
    expect(completedModel.json().userModel.socialHistory).toContain(roomId);

    const feedbackResponse = await send("大家很自然，线索任务让开场没那么尴尬，下次想要更小一点的深度交流");
    expect(feedbackResponse.statusCode).toBe(200);
    expect(feedbackResponse.json().job.result.actions[0].type).toBe("submit_feedback");

    const modelResponse = await app.inject({ method: "GET", url: `/users/${userId}/model` });
    expect(modelResponse.json().userModel.currentIntent.nextIntent).toContain("深度交流");
    expect(modelResponse.json().userModel.longTermProfile.socialPreferences).toBeTruthy();
    expect(modelResponse.json().userModel.socialHistory.filter((id: string) => id === roomId)).toHaveLength(1);
  });

  it("persists a rolling summary once the recent-message window is exceeded", async () => {
    const { app, store } = setup();
    const userId = randomUUID();
    for (let index = 0; index < 12; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/agent/messages",
        payload: {
          userId,
          displayName: "长期对话测试用户",
          content: `第 ${index + 1} 条长期对话`,
          idempotencyKey: randomUUID()
        }
      });
      expect(response.statusCode).toBe(200);
    }
    const conversation = await store.getConversationState(userId);
    expect(conversation.summarizedMessageCount).toBeGreaterThan(0);
    expect(conversation.rollingSummary).toContain("长期对话");
  });

  it("rejects multimodal paths owned by another user", async () => {
    const { app } = setup();
    const userId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/agent/multimodal-inputs",
      payload: {
        userId,
        kind: "image",
        storagePath: `${randomUUID()}/photo.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024
      }
    });
    expect(response.statusCode).toBe(409);
  });

  it("accepts an image upload and folds its vibe into the conversation", async () => {
    const { app } = setup();
    const userId = randomUUID();
    const uploaded = await app.inject({
      method: "POST",
      url: "/uploads",
      payload: {
        userId,
        fileName: "moment.jpg",
        mimeType: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${Buffer.from("test-image").toString("base64")}`
      }
    });
    expect(uploaded.statusCode).toBe(200);
    const upload = uploaded.json();
    const understood = await app.inject({
      method: "POST",
      url: "/agent/multimodal-inputs",
      payload: {
        userId,
        kind: "image",
        storagePath: upload.storagePath,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        hint: "这是我喜欢的一段夜晚街景"
      }
    });
    expect(understood.statusCode).toBe(200);
    const model = await app.inject({ method: "GET", url: `/users/${userId}/model` });
    expect(model.json().userModel.vibeNarrative).toContain("夜晚街景");
    const messages = await app.inject({ method: "GET", url: `/agent/messages/${userId}` });
    expect(messages.json().messages.some((message: { role: string }) => message.role === "assistant")).toBe(true);
  });

  it("deduplicates concurrent active match requests for one user", async () => {
    const { store } = setup();
    const userId = randomUUID();
    const requests = await Promise.all(
      Array.from({ length: 50 }, () => store.createMatchRequest(userId, { rawText: "想认识新朋友" }))
    );
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(1);
  });

  it("only cancels match requests that are still matching", async () => {
    const { store } = setup();
    const userId = randomUUID();
    const request = await store.createMatchRequest(userId, { rawText: "想认识新朋友" });
    await store.cancelMatchRequest(request.requestId);
    await expect(store.cancelMatchRequest(request.requestId)).rejects.toThrow("只能取消仍在匹配中的请求");
  });

  it("claims each queued job at most once across concurrent worker slots", async () => {
    const { store } = setup();
    await Promise.all(Array.from({ length: 40 }, (_, index) => store.enqueueJob({
      type: "matchmaking",
      payload: { index },
      idempotencyKey: `concurrency-job-${index}`
    })));
    const claimed = await Promise.all(Array.from({ length: 32 }, (_, index) => store.claimJob(`worker-${index}`)));
    const ids = claimed.flatMap((job) => job ? [job.id] : []);
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
  });
});
