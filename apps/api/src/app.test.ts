import { randomUUID } from "node:crypto";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { MemoryStore } from "@tomeet/data";
import { JobProcessor } from "@tomeet/intelligence";
import { MockMatchmakingIntelligence } from "@tomeet/matchmaking";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { AuthenticationError } from "./auth.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function setup() {
  const store = new MemoryStore({ seedDemoData: true });
  const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence());
  const app = await buildApp({ store, inlineProcessor: processor });
  apps.push(app);
  return { app, store };
}

async function setupWithAuth(userByToken: Record<string, string>) {
  const store = new MemoryStore({ seedDemoData: true });
  const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence());
  const app = await buildApp({
    store,
    inlineProcessor: processor,
    verifyAccessToken: async (token) => {
      const userId = userByToken[token];
      if (!userId) throw new AuthenticationError("登录状态无效或已过期");
      return userId;
    }
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("TOMEET core flow", () => {
  it("requires a valid bearer token while keeping health checks public", async () => {
    const userId = randomUUID();
    const { app } = await setupWithAuth({ valid: userId });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const missing = await app.inject({ method: "GET", url: "/offline-games" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toBe("UNAUTHENTICATED");

    const invalid = await app.inject({
      method: "GET",
      url: "/offline-games",
      headers: { authorization: "Bearer invalid" }
    });
    expect(invalid.statusCode).toBe(401);

    const valid = await app.inject({
      method: "GET",
      url: "/offline-games",
      headers: { authorization: "Bearer valid" }
    });
    expect(valid.statusCode).toBe(200);
  });

  it("binds user-scoped requests and resources to the authenticated user", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const { app, store } = await setupWithAuth({ valid: userId });
    const headers = { authorization: "Bearer valid" };

    const mismatchedBody = await app.inject({
      method: "POST",
      url: "/agent/messages",
      headers,
      payload: {
        userId: otherUserId,
        displayName: "越权用户",
        content: "读取别人的数据",
        idempotencyKey: randomUUID()
      }
    });
    expect(mismatchedBody.statusCode).toBe(403);
    expect(mismatchedBody.json().error).toBe("FORBIDDEN");

    const otherRequest = await store.createMatchRequest(otherUserId, { rawText: "想认识新朋友" });
    const hiddenRequest = await app.inject({
      method: "GET",
      url: `/match-requests/${otherRequest.requestId}`,
      headers
    });
    expect(hiddenRequest.statusCode).toBe(404);

    const otherJob = await store.enqueueJob({
      type: "agent_reply",
      payload: { userId: otherUserId },
      idempotencyKey: randomUUID(),
      partitionKey: `user:${otherUserId}`
    });
    const hiddenJob = await app.inject({
      method: "GET",
      url: `/jobs/${otherJob.id}`,
      headers
    });
    expect(hiddenJob.statusCode).toBe(404);
  });

  it("rate limits requests before authentication and keeps the API error shape", async () => {
    const userId = randomUUID();
    const store = new MemoryStore({ seedDemoData: true });
    const app = await buildApp({
      store,
      rateLimitMax: 1,
      verifyAccessToken: async () => userId
    });
    apps.push(app);

    const first = await app.inject({
      method: "GET",
      url: "/offline-games",
      headers: { authorization: "Bearer valid" }
    });
    const limited = await app.inject({
      method: "GET",
      url: "/offline-games",
      headers: { authorization: "Bearer valid" }
    });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("RATE_LIMITED");
    expect(limited.json().requestId).toBeTruthy();
  });

  it("protects and resolves server-managed channel identities", async () => {
    const store = new MemoryStore();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence());
    const internalApiToken = "test-internal-token-that-is-at-least-32-characters";
    const app = await buildApp({
      store,
      inlineProcessor: processor,
      internalApiToken,
      rateLimitMax: 1
    });
    apps.push(app);
    const userId = randomUUID();
    await store.ensureUser(userId, "Channel User");

    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/channel-identities/resolve",
      payload: { provider: "wechat", externalUserId: "wxid_unauthorized" }
    });
    expect(unauthorized.statusCode).toBe(401);

    const linked = await app.inject({
      method: "POST",
      url: "/internal/channel-identities",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: {
        provider: "wechat",
        externalUserId: "wxid_channel_user",
        userId,
        displayName: "WeChat User"
      }
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().identity.userId).toBe(userId);

    const resolved = await app.inject({
      method: "POST",
      url: "/internal/channel-identities/resolve",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { provider: "wechat", externalUserId: "wxid_channel_user" }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().identity.userId).toBe(userId);
  });

  it("auto-provisions deterministic channel users only when explicitly enabled", async () => {
    const store = new MemoryStore();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence());
    const internalApiToken = "test-internal-token-that-is-at-least-32-characters";
    const app = await buildApp({
      store,
      inlineProcessor: processor,
      internalApiToken,
      autoProvisionChannelUsers: true
    });
    apps.push(app);

    const resolveIdentity = () => app.inject({
      method: "POST",
      url: "/internal/channel-identities/resolve",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { provider: "wechat", externalUserId: "wxid_demo_auto_user" }
    });
    const first = await resolveIdentity();
    const second = await resolveIdentity();
    expect(first.statusCode).toBe(200);
    expect(first.json().identity.userId).toBe(second.json().identity.userId);
  });

  it("runs the complete social flow using conversation only", async () => {
    const { app } = await setup();
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
    expect(modelResponse.json().userModel.longTermProfile.socialPreferences).toBeUndefined();
    expect(modelResponse.json().userModel).not.toHaveProperty("profileNarrative");
    expect(modelResponse.json().userModel.feedbackMemory[0]).toContain("大家很自然");
    expect(modelResponse.json().userModel.socialHistory.filter((id: string) => id === roomId)).toHaveLength(1);
  });

  it("persists a rolling summary once the recent-message window is exceeded", async () => {
    const { app, store } = await setup();
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
    const { app } = await setup();
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

  it("accepts an image upload and stores only an expiring multimodal impression", async () => {
    const { app, store } = await setup();
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
    expect(model.json().userModel.vibeNarrative).toBe("");
    const memories = await store.listActiveMemories(userId);
    expect(memories[0]?.kind).toBe("multimodal_impression");
    expect(memories[0]?.expiresAt).toBeTruthy();
    expect((await store.getMemoryProfile(userId)).profileNarrative).toContain("夜晚街景");
    const messages = await app.inject({ method: "GET", url: `/agent/messages/${userId}` });
    expect(messages.json().messages.some((message: { role: string }) => message.role === "assistant")).toBe(true);
  });

  it("builds a hidden profile and forgets it through conversation without exposing it", async () => {
    const { app, store } = await setup();
    const userId = randomUUID();
    const send = (content: string) => app.inject({
      method: "POST",
      url: "/agent/messages",
      payload: { userId, displayName: "记忆用户", content, idempotencyKey: randomUUID() }
    });

    await send("我喜欢安静、有自然光的咖啡馆");
    const active = await store.listActiveMemories(userId);
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toContain("咖啡馆");
    expect((await store.getMemoryProfile(userId)).profileNarrative).toContain("咖啡馆");

    const publicModel = await app.inject({ method: "GET", url: `/users/${userId}/model` });
    expect(JSON.stringify(publicModel.json())).not.toContain("有自然光的咖啡馆");

    await send("请忘记我喜欢咖啡馆这件事");
    expect(await store.listActiveMemories(userId)).toHaveLength(0);
    const forgottenProfile = await store.getMemoryProfile(userId);
    expect(forgottenProfile.stale).toBe(false);
    expect(forgottenProfile.profileNarrative).toBe("");
  });

  it("deduplicates concurrent active match requests for one user", async () => {
    const { store } = await setup();
    const userId = randomUUID();
    const requests = await Promise.all(
      Array.from({ length: 50 }, () => store.createMatchRequest(userId, { rawText: "想认识新朋友" }))
    );
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(1);
  });

  it("only cancels match requests that are still matching", async () => {
    const { store } = await setup();
    const userId = randomUUID();
    const request = await store.createMatchRequest(userId, { rawText: "想认识新朋友" });
    await store.cancelMatchRequest(request.requestId);
    await expect(store.cancelMatchRequest(request.requestId)).rejects.toThrow("只能取消仍在匹配中的请求");
  });

  it("claims each queued job at most once across concurrent worker slots", async () => {
    const { store } = await setup();
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
