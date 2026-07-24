import { randomUUID } from "node:crypto";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { adventurexWelcomeContent } from "@tomeet/contracts";
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
  it("shares WeChat messages with Web while preserving each reply's origin", async () => {
    const userId = randomUUID();
    const internalApiToken = "shared-channel-test-token-at-least-32-characters";
    const store = new MemoryStore();
    const seenContexts: string[][] = [];
    const agent = new class extends MockAgentIntelligence {
      override async reply(...args: Parameters<MockAgentIntelligence["reply"]>) {
        seenContexts.push(args[0].recentMessages.map((message) => message.content));
        return super.reply(...args);
      }
    }();
    const processor = new JobProcessor(
      store,
      agent,
      new MockMatchmakingIntelligence()
    );
    const app = await buildApp({
      store,
      inlineProcessor: processor,
      internalApiToken,
      verifyAccessToken: async (token) => {
        if (token === "web-token") return userId;
        throw new AuthenticationError("登录状态无效或已过期");
      }
    });
    apps.push(app);

    const web = await app.inject({
      method: "POST",
      url: "/agent/messages",
      headers: { authorization: "Bearer web-token" },
      payload: {
        userId,
        displayName: "跨渠道用户",
        content: "这是网页消息",
        idempotencyKey: randomUUID()
      }
    });
    expect(web.statusCode).toBe(200);
    expect(web.json().userMessage.sourceChannel).toBe("web");
    expect(web.json().job.result.message.sourceChannel).toBe("web");
    await expect(store.enqueueWechatOutboundMessage(web.json().job.result.message))
      .rejects.toThrow("Web 对话消息不能投递到微信");

    const wechat = await app.inject({
      method: "POST",
      url: "/internal/agent/messages",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: {
        userId,
        displayName: "跨渠道用户",
        content: "这是微信消息",
        idempotencyKey: randomUUID()
      }
    });
    expect(wechat.statusCode).toBe(200);
    expect(wechat.json().userMessage.sourceChannel).toBe("wechat");
    expect(wechat.json().job.result.message).toMatchObject({
      sourceChannel: "wechat",
      replyToMessageId: wechat.json().userMessage.id
    });
    expect(seenContexts.at(-1)).toContain("这是网页消息");

    const history = await app.inject({
      method: "GET",
      url: `/agent/messages/${userId}`,
      headers: { authorization: "Bearer web-token" }
    });
    expect(history.statusCode).toBe(200);
    expect(new Set(history.json().messages.map(
      (message: { sourceChannel?: string }) => message.sourceChannel
    ))).toEqual(new Set(["web", "wechat"]));

    const proactiveMessage = await store.appendMessage({
      userId,
      role: "assistant",
      content: "Web 已授权后产生的微信主动通知",
      idempotencyKey: "shared-channel-proactive",
      sourceChannel: "system"
    });
    await expect(store.enqueueWechatOutboundMessage(proactiveMessage)).resolves.toBeUndefined();
  });

  it("requires a valid bearer token while keeping health checks public", async () => {
    const userId = randomUUID();
    const { app } = await setupWithAuth({ valid: userId });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().service).toBe("tomeet-api");

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

  it("restricts the virtual AdventureX pool switch to the configured owner account", async () => {
    const ownerUserId = randomUUID();
    const otherUserId = randomUUID();
    const store = new MemoryStore();
    const app = await buildApp({
      store,
      verifyAccessToken: async (token) => {
        if (token === "owner-token") return ownerUserId;
        if (token === "other-token") return otherUserId;
        throw new AuthenticationError("登录状态无效或已过期");
      },
      adventurexTestPoolAccessTokenMatches: async (token) => token === "owner-token"
    });
    apps.push(app);

    const forbidden = await app.inject({
      method: "POST",
      url: "/adventurex/test-pool",
      headers: { authorization: "Bearer other-token" },
      payload: { enabled: true, desiredUserCount: 5 }
    });
    expect(forbidden.statusCode).toBe(403);

    const enabled = await app.inject({
      method: "POST",
      url: "/adventurex/test-pool",
      headers: { authorization: "Bearer owner-token" },
      payload: { enabled: true, desiredUserCount: 5 }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().testPool).toMatchObject({
      ownerUserId,
      enabled: true,
      desiredUserCount: 5,
      provisionedUserCount: 5
    });

    const status = await app.inject({
      method: "GET",
      url: "/adventurex/test-pool",
      headers: { authorization: "Bearer owner-token" }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().testPool.ownerUserId).toBe(ownerUserId);
  });

  it("fails readiness without failing liveness when the database stalls", async () => {
    const store = new MemoryStore();
    store.ping = async () =>
      new Promise<void>(() => {
        // Intentionally unresolved to exercise the readiness timeout.
      });
    const app = await buildApp({ store, readinessTimeoutMs: 10 });
    apps.push(app);

    const [health, ready] = await Promise.all([
      app.inject({ method: "GET", url: "/health" }),
      app.inject({ method: "GET", url: "/ready" })
    ]);
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().status).toBe("not_ready");
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

  it("protects internal product events and lets the Agent compose the channel reply", async () => {
    const store = new MemoryStore();
    const processor = new JobProcessor(store, new MockAgentIntelligence(), new MockMatchmakingIntelligence());
    const internalApiToken = "test-internal-token-that-is-at-least-32-characters";
    const app = await buildApp({ store, inlineProcessor: processor, internalApiToken });
    apps.push(app);
    const userId = randomUUID();
    const payload = {
      userId,
      event: {
        kind: "unsupported_channel_message",
        facts: { channel: "wechat", supportedInputs: ["text"] }
      },
      idempotencyKey: randomUUID()
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/agent/events",
      payload
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: "POST",
      url: "/internal/agent/events",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job.type).toBe("agent_event_reply");
    expect(response.json().job.result.message).toMatchObject({
      userId,
      role: "assistant",
      content: "这条消息目前无法读取，你可以换一种方式告诉我。"
    });
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
    expect(historyResponse.json().messages.some((message: { content: string }) => message.content.includes("匹配已经完成"))).toBe(true);

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

  it("exposes idempotent AdventureX onboarding and creates a fresh scheduled rematch", async () => {
    const store = new MemoryStore();
    const processor = new JobProcessor(
      store,
      new MockAgentIntelligence(),
      new MockMatchmakingIntelligence(),
      { adventurexMatchingV1: true }
    );
    const app = await buildApp({ store, inlineProcessor: processor, adventurexMatchingV1: true });
    apps.push(app);
    const userId = randomUUID();
    const firstWelcome = await app.inject({ method: "POST", url: `/users/${userId}/adventurex-onboarding/start` });
    const secondWelcome = await app.inject({ method: "POST", url: `/users/${userId}/adventurex-onboarding/start` });
    expect(firstWelcome.statusCode).toBe(200);
    expect(secondWelcome.json().message.id).toBe(firstWelcome.json().message.id);
    expect(firstWelcome.json()).toMatchObject({
      state: { preferredLanguage: "zh", stage: "awaiting_image_or_text" },
      message: { content: adventurexWelcomeContent("zh") },
      messages: [{ content: adventurexWelcomeContent("zh") }]
    });
    const switchedToEnglish = await app.inject({
      method: "POST",
      url: "/agent/messages",
      payload: {
        userId,
        displayName: "现场用户",
        content: "Please use English",
        idempotencyKey: randomUUID()
      }
    });
    expect(switchedToEnglish.json().job.result.message.content).toBe(adventurexWelcomeContent("en"));
    expect((await store.ensureAdventurexOnboardingState(userId)).preferredLanguage).toBe("en");

    const englishUserId = randomUUID();
    const englishWelcome = await app.inject({
      method: "POST",
      url: `/users/${englishUserId}/adventurex-onboarding/start`,
      payload: { language: "en" }
    });
    expect(englishWelcome.json()).toMatchObject({
      state: { preferredLanguage: "en" },
      message: { content: adventurexWelcomeContent("en") },
      messages: [{ content: adventurexWelcomeContent("en") }]
    });

    const existingUserId = randomUUID();
    await store.appendMessage({ userId: existingUserId, role: "user", content: "已经聊过" });
    const noInjectedWelcome = await app.inject({
      method: "POST",
      url: `/users/${existingUserId}/adventurex-onboarding/start`,
      payload: { language: "zh" }
    });
    expect(noInjectedWelcome.json()).toMatchObject({ message: null, messages: [] });

    await app.inject({
      method: "POST",
      url: "/agent/messages",
      payload: { userId, displayName: "现场用户", content: "我想参加现场活动认识一些人", idempotencyKey: randomUUID() }
    });
    const firstRequest = await store.getLatestMatchRequestForUser(userId);
    expect(firstRequest).toMatchObject({ status: "matching", phase: "waiting" });
    expect(firstRequest?.activeRoundId).toBeTruthy();
    const cancelled = await app.inject({ method: "POST", url: `/match-requests/${firstRequest!.requestId}/cancel` });
    expect(cancelled.json().canRematch).toBe(true);
    const rematched = await app.inject({ method: "POST", url: `/match-requests/${firstRequest!.requestId}/rematch` });
    expect(rematched.statusCode).toBe(200);
    expect(rematched.json().matchRequest.requestId).not.toBe(firstRequest!.requestId);
  });

  it("records the relaxed boundary question so it is not repeated", async () => {
    const { app, store } = await setup();
    const userId = randomUUID();
    await app.inject({ method: "POST", url: `/users/${userId}/adventurex-onboarding/start` });
    const send = (content: string) => app.inject({
      method: "POST",
      url: "/agent/messages",
      payload: { userId, displayName: "边界测试用户", content, idempotencyKey: randomUUID() }
    });

    await send("最近在做一款小工具");
    await send("周末也会去看展");
    const boundaryReply = await send("最近还开始学摄影");
    expect(boundaryReply.json().job.result.message.content).toContain("雷点");
    const state = await store.ensureAdventurexOnboardingState(userId);
    expect(state.boundaryPromptedAt).not.toBeNull();

    const nextReply = await send("我平时也喜欢散步");
    expect(nextReply.json().job.result.message.content).not.toContain("最后再确认一下");
    expect((await store.ensureAdventurexOnboardingState(userId)).boundaryPromptedAt)
      .toBe(state.boundaryPromptedAt);
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
