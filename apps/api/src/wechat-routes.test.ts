import { randomBytes, randomUUID } from "node:crypto";
import { MockAgentIntelligence } from "@tomeet/agent-core";
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
  }
) {
  let qrIndex = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("get_bot_qrcode")) {
      qrIndex += 1;
      return new Response(JSON.stringify({
        qrcode: `private-qr-token-${qrIndex}`,
        qrcode_img_content: `weixin://connect/${qrIndex}`
      }));
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
  return { app, store, wechatStore, fetchMock, verifyAccessToken };
}

describe("WeChat one-time QR onboarding", () => {
  it("creates a profile and reuses it when the same WeChat identity reconnects", async () => {
    const confirmed = {
      status: "confirmed",
      bot_token: "bot-secret",
      ilink_bot_id: "bot-1",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "wechat-owner-1"
    };
    const { app, store, verifyAccessToken } = await setup([
      confirmed,
      { ...confirmed, ilink_bot_id: "bot-2", bot_token: "rotated-secret" }
    ]);

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
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("associates a QR session with an existing profile only through the internal API", async () => {
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
        (message: { content: string }) => message.content.includes("匹配完成了")
      )).toBe(true);
    }

    const wechatHistory = await app.inject({
      method: "GET",
      url: `/internal/agent/messages/${wechatUserId}`,
      headers: { "x-tomeet-internal-token": internalApiToken }
    });
    expect(wechatHistory.statusCode).toBe(200);
    expect(wechatHistory.json().messages.some(
      (message: { content: string }) => message.content.includes("匹配完成了")
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
    const completed = await app.inject({
      method: "POST",
      url: `/wechat/connect/sessions/${session.sessionId}/verify`,
      headers,
      payload: { code: "123456" }
    });
    expect(completed.json().status).toBe("active");
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
  });

  it("limits public QR creation to five attempts per ten minutes", async () => {
    const { app } = await setup([]);
    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/wechat/connect/sessions",
        payload: {}
      }));
    }

    expect(responses.slice(0, 5).every((response) => response.statusCode === 201))
      .toBe(true);
    expect(responses[5]?.statusCode).toBe(429);
  });

  it("supports a higher bounded QR limit for a managed kiosk", async () => {
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
    expect(response.headers["access-control-allow-headers"])
      .toContain("x-wechat-session-token");
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});
