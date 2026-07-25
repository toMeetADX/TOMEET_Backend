import { randomBytes, randomUUID } from "node:crypto";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { adventurexWelcomeBubbles, adventurexWelcomeContent } from "@tomeet/contracts";
import { MemoryStore, MemoryWechatStore } from "@tomeet/data";
import { JobProcessor } from "@tomeet/intelligence";
import { MockMatchmakingIntelligence } from "@tomeet/matchmaking";
import { CredentialCipher, WechatILinkClient } from "@tomeet/wechat-ilink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(
  statuses: Array<Record<string, unknown>>,
  internalApiToken?: string,
  sessionTtlMs?: number,
  wechatQrRateLimitMax?: number,
  integration?: {
    processJobsInline?: boolean;
    userByToken?: Record<string, string>;
    rapidQrTokens?: string[];
  }
) {
  let qrIndex = 0;
  const sentMessages: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("get_bot_qrcode")) {
      qrIndex += 1;
      return new Response(JSON.stringify({
        qrcode: `private-qr-token-${qrIndex}`,
        qrcode_img_content: `weixin://connect/${qrIndex}`
      }));
    }
    if (url.includes("sendmessage")) {
      sentMessages.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ ret: 0 }));
    }
    return new Response(JSON.stringify(statuses.shift() ?? { status: "wait" }));
  });
  const store = new MemoryStore();
  const wechatStore = new MemoryWechatStore(store);
  const verifyAccessToken = vi.fn(async (accessToken: string) => {
    const userId = integration?.userByToken?.[accessToken];
    if (userId) return userId;
    throw new Error("WeChat route unexpectedly required a bearer token");
  });
  const inlineProcessor = integration?.processJobsInline
    ? new JobProcessor(
        store,
        new MockAgentIntelligence(),
        new MockMatchmakingIntelligence()
      )
    : undefined;
  const app = await buildApp({
    store,
    inlineProcessor,
    internalApiToken,
    wechatQrRateLimitMax,
    verifyAccessToken,
    wechatRapidQrAccessTokenMatches: integration?.rapidQrTokens
      ? async (accessToken) => integration.rapidQrTokens!.includes(accessToken)
      : undefined,
    wechat: {
      store: wechatStore,
      client: new WechatILinkClient({
        fetch: fetchMock,
        longPollTimeoutMs: 100
      }),
      cipher: new CredentialCipher(randomBytes(32).toString("base64")),
      sessionTtlMs
    }
  });
  apps.push(app);
  return { app, store, wechatStore, fetchMock, verifyAccessToken, sentMessages };
}

function sentMessageTexts(messages: Array<Record<string, unknown>>): string[] {
  return messages.map((message) => {
    const msg = message.msg as { item_list?: Array<{ text_item?: { text?: string } }> };
    return msg.item_list?.[0]?.text_item?.text ?? "";
  });
}

describe("WeChat one-time QR onboarding", () => {
  it("returns QR creation secrets once and never exposes them from status or SSE", async () => {
    const { app } = await setup([{
      status: "confirmed",
      bot_token: "secret-bot-token",
      ilink_bot_id: "secure-bot",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "secure-owner"
    }]);
    const createdResponse = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      headers: { origin: "http://localhost:3000" },
      payload: {}
    });

    expect(createdResponse.statusCode).toBe(201);
    expect(createdResponse.headers["cache-control"]).toContain("no-store");
    expect(createdResponse.headers["access-control-allow-origin"])
      .toBe("http://localhost:3000");
    const created = createdResponse.json();
    expect(created.sessionToken).toEqual(expect.any(String));
    expect(created.qrCodeContent).toBe("weixin://connect/1");

    const statusResponse = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${created.sessionId}`,
      headers: {
        origin: "http://localhost:3000",
        "x-wechat-session-token": created.sessionToken
      }
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.headers["access-control-allow-origin"])
      .toBe("http://localhost:3000");
    expect(statusResponse.json()).not.toHaveProperty("sessionToken");
    expect(statusResponse.json()).not.toHaveProperty("qrCodeContent");
    expect(statusResponse.json()).not.toHaveProperty("botToken");
    expect(statusResponse.json()).not.toHaveProperty("sessionTokenHash");
    expect(statusResponse.json()).not.toHaveProperty("qrTokenCiphertext");

    const events = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${created.sessionId}/events`,
      headers: {
        accept: "text/event-stream",
        origin: "http://localhost:3000",
        "x-wechat-session-token": created.sessionToken
      }
    });
    expect(events.statusCode).toBe(200);
    expect(events.payload).not.toContain(created.sessionToken);
    expect(events.payload).not.toContain(created.qrCodeContent);
    expect(events.payload).not.toContain("secret-bot-token");
    expect(events.payload).not.toContain("sessionTokenHash");
    expect(events.payload).not.toContain("qrTokenCiphertext");
  });

  it("allows only the roadshow account to bypass the public QR creation limit", async () => {
    const roadshowUserId = randomUUID();
    const otherUserId = randomUUID();
    const { app, wechatStore } = await setup(
      [],
      undefined,
      undefined,
      1,
      {
        rapidQrTokens: ["roadshow-token"],
        userByToken: {
          "roadshow-token": roadshowUserId,
          "other-token": otherUserId
        }
      }
    );

    const publicCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(publicCreate.statusCode).toBe(201);
    const publicLimited = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(publicLimited.statusCode).toBe(429);

    const missingLogin = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      payload: {}
    });
    expect(missingLogin.statusCode).toBe(401);
    const wrongAccount = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer other-token" },
      payload: {}
    });
    expect(wrongAccount.statusCode).toBe(403);

    const first = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    });
    const second = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().sessionId).not.toBe(second.json().sessionId);
    expect(await wechatStore.getWechatSession(first.json().sessionId))
      .toMatchObject({ requestedUserId: null });
    expect(await wechatStore.getWechatSession(second.json().sessionId))
      .toMatchObject({ requestedUserId: null });
  });

  it("creates a profile and reuses it when the same WeChat identity reconnects", async () => {
    const confirmed = {
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot-1",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "wechat-owner-1"
    };
    const { app, store, verifyAccessToken, sentMessages } = await setup([
      confirmed,
      { ...confirmed, ilink_bot_id: "bot-2", bot_token: "rotated-secret" }
    ]);
    const enqueueWelcome = vi.spyOn(store, "enqueueWechatOutboundMessage");

    const firstCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(firstCreate.statusCode).toBe(201);
    const first = firstCreate.json();
    expect(first.qrCodeContent).toBe("weixin://connect/1");
    expect(JSON.stringify(first)).not.toContain("private-qr-token");
    expect(JSON.stringify(first)).not.toContain("bot-secret");

    const unauthorized = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${first.sessionId}`,
      headers: { "x-wechat-session-token": "wrong" }
    });
    expect(unauthorized.statusCode).toBe(401);

    const firstConfirmed = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${first.sessionId}`,
      headers: { "x-wechat-session-token": first.sessionToken }
    });
    expect(firstConfirmed.statusCode).toBe(200);
    expect(firstConfirmed.json().status).toBe("active");
    expect(firstConfirmed.json()).not.toHaveProperty("userId");
    const firstIdentity = await store.resolveChannelIdentity(
      "wechat",
      "wechat-owner-1"
    );
    expect(firstIdentity).not.toBeNull();
    const firstUserId = firstIdentity!.userId;
    expect((await store.getUserModel(firstUserId)).userId).toBe(firstUserId);
    expect(enqueueWelcome).not.toHaveBeenCalled();
    expect(sentMessageTexts(sentMessages)).toEqual(adventurexWelcomeBubbles.zh);
    expect(await store.listRecentMessages(firstUserId)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: adventurexWelcomeContent("zh")
      })
    ]);
    expect(await store.ensureAdventurexOnboardingState(firstUserId)).toMatchObject({
      preferredLanguage: "zh",
      welcomeSentAt: expect.any(String),
      welcomeDeliveredAt: expect.any(String)
    });

    const secondCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const second = secondCreate.json();
    const secondConfirmed = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${second.sessionId}`,
      headers: { "x-wechat-session-token": second.sessionToken }
    });
    expect(secondConfirmed.json()).toMatchObject({ status: "active" });
    expect(secondConfirmed.json()).not.toHaveProperty("userId");
    expect(await store.resolveChannelIdentity("wechat", "wechat-owner-1"))
      .toMatchObject({ userId: firstUserId });
    expect(sentMessageTexts(sentMessages)).toEqual(adventurexWelcomeBubbles.zh);
    expect(await store.listRecentMessages(firstUserId)).toHaveLength(1);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("reuses the scanner profile instead of binding it to the roadshow operator", async () => {
    const roadshowUserId = randomUUID();
    const owner = "wechat-owner-roadshow-reconnect";
    const confirmed = {
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot-roadshow-1",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: owner
    };
    const { app, store } = await setup(
      [confirmed, {
        ...confirmed,
        bot_token: "rotated-secret",
        ilink_bot_id: "bot-roadshow-2"
      }],
      undefined,
      undefined,
      undefined,
      {
        rapidQrTokens: ["roadshow-token"],
        userByToken: { "roadshow-token": roadshowUserId }
      }
    );

    const firstCreated = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const first = firstCreated.json();
    const firstActivated = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${first.sessionId}`,
      headers: { "x-wechat-session-token": first.sessionToken }
    });
    expect(firstActivated.json()).toMatchObject({ status: "active" });
    const scannerUserId = (await store.resolveChannelIdentity("wechat", owner))!.userId;
    expect(scannerUserId).not.toBe(roadshowUserId);

    const secondCreated = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    });
    const second = secondCreated.json();
    const secondActivated = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${second.sessionId}`,
      headers: { "x-wechat-session-token": second.sessionToken }
    });

    expect(secondActivated.statusCode).toBe(200);
    expect(secondActivated.json()).toMatchObject({ status: "active" });
    expect(await store.resolveChannelIdentity("wechat", owner))
      .toMatchObject({ userId: scannerUserId });
  });

  it("claims activation once when concurrent QR polls both observe confirmation", async () => {
    const confirmed = {
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot-concurrent",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "wechat-owner-concurrent"
    };
    const { app, store, sentMessages } = await setup([confirmed, confirmed]);
    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const session = created.json();

    const responses = await Promise.all([1, 2].map(() => app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    })));

    expect(responses.map((response) => ({ code: response.statusCode, body: response.json() })))
      .toEqual([
        { code: 200, body: expect.objectContaining({ status: "active" }) },
        { code: 200, body: expect.objectContaining({ status: "active" }) }
      ]);
    expect(sentMessageTexts(sentMessages)).toEqual(adventurexWelcomeBubbles.zh);
    const identity = await store.resolveChannelIdentity("wechat", "wechat-owner-concurrent");
    expect(identity).not.toBeNull();
    expect(await store.listRecentMessages(identity!.userId)).toEqual([
      expect.objectContaining({ content: adventurexWelcomeContent("zh") })
    ]);
  });

  it("keeps polling a claimed QR after the frontend refreshes the displayed code", async () => {
    const ownerIlinkUserId = "wechat-owner-background-confirmation";
    const { app, store, wechatStore, sentMessages } = await setup([
      { status: "scaned" },
      {
        status: "confirmed",
        bot_token: "background-bot-secret",
        ilink_bot_id: "background-bot",
        baseurl: "https://ilink-api.example.com",
        ilink_user_id: ownerIlinkUserId
      }
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const claimedSession = created.json();

    const scanned = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${claimedSession.sessionId}`,
      headers: { "x-wechat-session-token": claimedSession.sessionToken }
    });
    expect(scanned.json()).toMatchObject({ status: "scanned" });

    const replacement = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(replacement.json()).toMatchObject({
      status: "pending",
      qrCodeContent: "weixin://connect/2"
    });

    await vi.waitFor(async () => {
      expect(await wechatStore.getWechatSession(claimedSession.sessionId))
        .toMatchObject({ status: "active" });
      expect(sentMessageTexts(sentMessages)).toEqual(adventurexWelcomeBubbles.zh);
    });
    expect(await store.resolveChannelIdentity("wechat", ownerIlinkUserId)).not.toBeNull();
  });

  it("accepts scaned as the terminal handshake when it already carries credentials", async () => {
    const { app, store, wechatStore, sentMessages } = await setup([{
      status: "scaned",
      bot_token: "scaned-bot-secret",
      ilink_bot_id: "scaned-bot",
      ilink_user_id: "wechat-owner-scaned-with-credentials"
    }]);
    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const session = created.json();
    const scanned = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    });

    expect(scanned.json()).toMatchObject({ status: "scanned" });
    await vi.waitFor(async () => {
      expect(await wechatStore.getWechatSession(session.sessionId))
        .toMatchObject({ status: "active" });
      expect(sentMessageTexts(sentMessages)).toEqual(adventurexWelcomeBubbles.zh);
    });
    const identity = await store.resolveChannelIdentity(
      "wechat",
      "wechat-owner-scaned-with-credentials"
    );
    expect(identity).not.toBeNull();
    expect(await store.listRecentMessages(identity!.userId)).toHaveLength(1);
  });

  it("supports server-side QR creation for an existing profile", async () => {
    const internalApiToken = "internal-test-token-with-at-least-32-characters";
    const owner = "existing-profile-wechat";
    const { app, store } = await setup([{
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot-existing",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: owner
    }], internalApiToken);
    const userId = randomUUID();
    await store.ensureUser(userId, "已有用户");

    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/wechat/connect/sessions",
      payload: { userId }
    });
    expect(unauthorized.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/internal/wechat/connect/sessions",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { userId }
    });
    expect(created.statusCode).toBe(201);
    const session = created.json();
    const confirmed = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    });
    expect(confirmed.json()).toMatchObject({ status: "active" });
    expect(await store.resolveChannelIdentity("wechat", owner))
      .toMatchObject({ userId });
  });

  it("protects and idempotently exposes the first-inbound onboarding welcome", async () => {
    const internalApiToken = "internal-onboarding-token-at-least-32-characters";
    const { app, store } = await setup([], internalApiToken);
    const userId = randomUUID();

    const unauthorized = await app.inject({
      method: "POST",
      url: `/internal/users/${userId}/adventurex-onboarding/start`,
      payload: { language: "zh" }
    });
    expect(unauthorized.statusCode).toBe(401);

    const first = await app.inject({
      method: "POST",
      url: `/internal/users/${userId}/adventurex-onboarding/start`,
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { language: "zh" }
    });
    const second = await app.inject({
      method: "POST",
      url: `/internal/users/${userId}/adventurex-onboarding/start`,
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { language: "zh" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      message: { content: adventurexWelcomeContent("zh") }
    });
    expect(second.json().message.id).toBe(first.json().message.id);
    expect(await store.listRecentMessages(userId)).toEqual([
      expect.objectContaining({ id: first.json().message.id })
    ]);
  });

  it("binds an authenticated Web QR session to the same shared profile", async () => {
    const userId = randomUUID();
    const accessToken = "shared-web-wechat-token";
    const owner = "authenticated-web-wechat-owner";
    const { app, store, verifyAccessToken } = await setup([{
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot-shared-profile",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: owner
    }], undefined, undefined, undefined, {
      userByToken: { [accessToken]: userId }
    });
    await store.ensureUser(userId, "Web 与微信共享用户");

    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {}
    });
    expect(created.statusCode).toBe(201);
    const session = created.json();
    const activated = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    });
    expect(activated.json()).toMatchObject({ status: "active" });
    expect(await store.resolveChannelIdentity("wechat", owner))
      .toMatchObject({ userId });
    expect(verifyAccessToken).toHaveBeenCalledWith(accessToken);
  });

  it("automatically matches independent Web and WeChat users in one shared room", async () => {
    const internalApiToken = "cross-channel-internal-token-at-least-32-characters";
    const webUsers = [
      { userId: randomUUID(), token: "web-user-token-a", displayName: "Web 用户 A" },
      { userId: randomUUID(), token: "web-user-token-b", displayName: "Web 用户 B" }
    ];
    const ownerIlinkUserId = "cross-channel-wechat-owner";
    const { app, store } = await setup(
      [{
        status: "confirmed",
        bot_token: "cross-channel-bot-secret",
        ilink_bot_id: "cross-channel-bot",
        baseurl: "https://ilink-api.example.com",
        ilink_user_id: ownerIlinkUserId
      }],
      internalApiToken,
      undefined,
      undefined,
      {
        processJobsInline: true,
        userByToken: Object.fromEntries(
          webUsers.map((user) => [user.token, user.userId])
        )
      }
    );

    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(created.statusCode).toBe(201);
    const session = created.json();
    const activated = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    });
    expect(activated.json()).toMatchObject({ status: "active" });

    const wechatIdentity = await store.resolveChannelIdentity(
      "wechat",
      ownerIlinkUserId
    );
    expect(wechatIdentity).not.toBeNull();
    const wechatUserId = wechatIdentity!.userId;
    expect(webUsers.map((user) => user.userId)).not.toContain(wechatUserId);

    for (const webUser of webUsers) {
      const response = await app.inject({
        method: "POST",
        url: "/agent/messages",
        headers: { authorization: `Bearer ${webUser.token}` },
        payload: {
          userId: webUser.userId,
          displayName: webUser.displayName,
          content: "我想认识一些新朋友，轻松自然地聊聊",
          idempotencyKey: randomUUID()
        }
      });
      expect(response.statusCode).toBe(200);
    }

    for (const webUser of webUsers) {
      const accepted = await app.inject({
        method: "POST",
        url: "/agent/messages",
        headers: { authorization: `Bearer ${webUser.token}` },
        payload: {
          userId: webUser.userId,
          displayName: webUser.displayName,
          content: "接受匹配",
          idempotencyKey: randomUUID()
        }
      });
      expect(accepted.statusCode).toBe(200);
    }
    const founderRoom = await store.getLatestRoomForUser(webUsers[0]!.userId);
    expect(founderRoom?.eventPlans.draft?.version).toBe(1);
    await store.confirmEventPlan(
      founderRoom!.roomId,
      founderRoom!.members[0]!.userId,
      1
    );
    await store.confirmEventPlan(
      founderRoom!.roomId,
      founderRoom!.members[1]!.userId,
      1
    );

    const wechatResponse = await app.inject({
      method: "POST",
      url: "/internal/agent/messages",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: {
        userId: wechatUserId,
        displayName: "微信用户",
        content: "我也想认识新朋友，轻松自然一点",
        idempotencyKey: randomUUID()
      }
    });
    expect(wechatResponse.statusCode).toBe(200);
    const pendingWechatInvite = await store.getLatestMatchInviteForUser(wechatUserId);
    expect(pendingWechatInvite).toMatchObject({
      kind: "room_join",
      status: "pending",
      eventPlan: { version: 1, status: "published" }
    });

    const wechatAccepted = await app.inject({
      method: "POST",
      url: "/internal/agent/messages",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: {
        userId: wechatUserId,
        displayName: "微信用户",
        content: "接受邀请",
        idempotencyKey: randomUUID()
      }
    });
    expect(wechatAccepted.statusCode).toBe(200);

    const allUserIds = [...webUsers.map((user) => user.userId), wechatUserId];
    const rooms = await Promise.all(
      allUserIds.map((userId) => store.getLatestRoomForUser(userId))
    );
    expect(rooms.every(Boolean)).toBe(true);
    expect(new Set(rooms.map((room) => room!.roomId))).toHaveLength(1);
    expect(new Set(rooms[0]!.members.map((member) => member.userId)))
      .toEqual(new Set(allUserIds));

    for (const webUser of webUsers) {
      const history = await app.inject({
        method: "GET",
        url: `/agent/messages/${webUser.userId}`,
        headers: { authorization: `Bearer ${webUser.token}` }
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().messages.some(
        (message: { content: string }) => message.content.includes("活动清单")
      )).toBe(true);
    }

    const wechatHistory = await app.inject({
      method: "GET",
      url: `/internal/agent/messages/${wechatUserId}`,
      headers: { "x-tomeet-internal-token": internalApiToken }
    });
    expect(wechatHistory.statusCode).toBe(200);
    expect(wechatHistory.json().messages.some(
      (message: { content: string }) => message.content.includes("活动清单")
    )).toBe(true);
  });

  it("supports redirect and verification-required protocol states", async () => {
    const { app } = await setup([
      { status: "scaned_but_redirect", redirect_host: "redirect.weixin.example.com" },
      { status: "need_verifycode" },
      {
        status: "confirmed",
        bot_token: "bot-secret",
        ilink_bot_id: "bot-verified",
        baseurl: "https://ilink-api.example.com",
        ilink_user_id: "verified-owner"
      }
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const session = created.json();
    const headers = { "x-wechat-session-token": session.sessionToken };

    const redirected = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers
    });
    expect(redirected.json().status).toBe("scanned");
    const verification = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers
    });
    expect(verification.json().status).toBe("verification_required");
    const invalidCode = await app.inject({
      method: "POST",
      url: `/wechat/connect/sessions/${session.sessionId}/verify`,
      headers,
      payload: { code: "12ab" }
    });
    expect(invalidCode.statusCode).toBe(400);
    const completed = await app.inject({
      method: "POST",
      url: `/wechat/connect/sessions/${session.sessionId}/verify`,
      headers,
      payload: { code: "123456" }
    });
    expect(completed.json().status).toBe("active");
  });

  it("streams QR state changes over SSE until the session is terminal", async () => {
    const { app } = await setup([
      { status: "scaned" },
      {
        status: "confirmed",
        bot_token: "bot-secret",
        ilink_bot_id: "bot-streamed",
        baseurl: "https://ilink-api.example.com",
        ilink_user_id: "streamed-owner"
      }
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const session = created.json();
    const events = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}/events`,
      headers: {
        accept: "text/event-stream",
        "x-wechat-session-token": session.sessionToken
      }
    });

    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.payload).toContain('"status":"pending"');
    expect(events.payload).toContain('"status":"scanned"');
    expect(events.payload).toContain('"status":"active"');
    expect(events.payload).toContain("event: done");
  });

  it("expires stale QR sessions without polling upstream", async () => {
    const { app, fetchMock } = await setup([], undefined, -1);
    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const session = created.json();
    const expired = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    });

    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toMatchObject({
      status: "expired",
      errorCode: "qr_expired"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces verification blocking as a terminal failure", async () => {
    const { app } = await setup([{ status: "verify_code_blocked" }]);
    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const session = created.json();
    const blocked = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    });

    expect(blocked.json()).toMatchObject({
      status: "failed",
      errorCode: "verification_blocked"
    });
  });

  it("rejects non-HTTPS iLink redirect and confirmation hosts", async () => {
    const { app } = await setup([
      {
        status: "scaned_but_redirect",
        redirect_host: "http://127.0.0.1:6174"
      },
      {
        status: "confirmed",
        bot_token: "bot-secret",
        ilink_bot_id: "bot-unsafe",
        baseurl: "https://user:password@ilink.example.com",
        ilink_user_id: "unsafe-owner"
      }
    ]);

    const firstCreated = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const first = firstCreated.json();
    const redirectFailure = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${first.sessionId}`,
      headers: { "x-wechat-session-token": first.sessionToken }
    });
    expect(redirectFailure.json()).toMatchObject({
      status: "failed",
      errorCode: "invalid_redirect_host"
    });

    const secondCreated = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const second = secondCreated.json();
    const confirmationFailure = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${second.sessionId}`,
      headers: { "x-wechat-session-token": second.sessionToken }
    });
    expect(confirmationFailure.json()).toMatchObject({
      status: "failed",
      errorCode: "invalid_confirmation_host"
    });
  });

  it("rejects rebinding an existing WeChat identity to another profile", async () => {
    const internalApiToken = "internal-test-token-with-at-least-32-characters";
    const confirmed = {
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot-1",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "wechat-owner-conflict"
    };
    const { app, store } = await setup(
      [confirmed, { ...confirmed, bot_token: "bot-secret-2", ilink_bot_id: "bot-2" }],
      internalApiToken
    );
    const firstCreated = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const first = firstCreated.json();
    const firstConfirmed = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${first.sessionId}`,
      headers: { "x-wechat-session-token": first.sessionToken }
    });
    expect(firstConfirmed.statusCode).toBe(200);

    const otherUserId = randomUUID();
    await store.ensureUser(otherUserId, "另一个用户");
    const secondCreated = await app.inject({
      method: "POST",
      url: "/internal/wechat/connect/sessions",
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { userId: otherUserId }
    });
    const second = secondCreated.json();
    const conflict = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${second.sessionId}`,
      headers: { "x-wechat-session-token": second.sessionToken }
    });

    expect(conflict.statusCode).toBe(409);
    expect(await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${second.sessionId}`,
      headers: { "x-wechat-session-token": second.sessionToken }
    }).then((response) => response.json())).toMatchObject({
      status: "failed",
      errorCode: "profile_binding_conflict",
      errorMessage: "该微信已关联其他 TOMEET profile"
    });
  });

  it("limits public QR creation to thirty attempts per ten minutes", async () => {
    const { app } = await setup([]);
    const responses = [];
    for (let index = 0; index < 31; index += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/wechat/connect/sessions",
        payload: {}
      }));
    }

    expect(responses.slice(0, 30).every((response) => response.statusCode === 201))
      .toBe(true);
    expect(responses[30]?.statusCode).toBe(429);
    expect(Number(responses[30]?.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("supports a configurable bounded QR limit for a managed kiosk", async () => {
    const { app } = await setup([], undefined, undefined, 7);
    const responses = [];
    for (let index = 0; index < 8; index += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/wechat/connect/sessions",
        payload: {}
      }));
    }

    expect(responses.slice(0, 7).every((response) => response.statusCode === 201))
      .toBe(true);
    expect(responses[7]?.statusCode).toBe(429);
  });

  it("allows the browser session header in CORS preflight", async () => {
    const { app, verifyAccessToken } = await setup([]);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/wechat/connect/sessions/26000000-0000-4000-8000-000000000001",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-wechat-session-token"
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"])
      .toBe("http://localhost:3000");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("GET");
    expect(response.headers["access-control-allow-headers"])
      .toContain("x-wechat-session-token");
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("does not emit CORS approval for an unconfigured browser origin", async () => {
    const { app, verifyAccessToken } = await setup([]);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/wechat/connect/sessions/26000000-0000-4000-8000-000000000001",
      headers: {
        origin: "https://untrusted.example.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-wechat-session-token"
      }
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});
