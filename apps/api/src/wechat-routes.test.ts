import { randomBytes, randomUUID } from "node:crypto";
import { MockAgentIntelligence } from "@tomeet/agent-core";
import { adventurexWelcomeBubbles } from "@tomeet/contracts";
import { MemoryStore, MemoryWechatStore } from "@tomeet/data";
import { JobProcessor } from "@tomeet/intelligence";
import { MockMatchmakingIntelligence } from "@tomeet/matchmaking";
import {
  CredentialCipher,
  WechatILinkClient,
  type WechatConnection
} from "@tomeet/wechat-ilink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

function memoryConnections(wechatStore: MemoryWechatStore): Map<string, WechatConnection> {
  return (wechatStore as unknown as {
    connections: Map<string, WechatConnection>;
  }).connections;
}

function qrLocalTokenLists(
  fetchMock: ReturnType<typeof vi.fn>
): string[][] {
  return fetchMock.mock.calls
    .filter(([input]) => String(input).includes("get_bot_qrcode"))
    .map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as {
        local_token_list?: string[];
      };
      return body.local_token_list ?? [];
    });
}

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
    rapidQrRateLimitMax?: number;
    webRegistration?: boolean;
    provisionedUserId?: string;
    provisionError?: Error;
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
  const provisionedUserId = integration?.provisionedUserId ?? randomUUID();
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
  const accountProvisioner = {
    provision: vi.fn(async () => {
      if (integration?.provisionError) throw integration.provisionError;
      return {
        userId: provisionedUserId,
        accessToken: "anonymous-access-token",
        refreshToken: "anonymous-refresh-token",
        sessionExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
      };
    }),
    discard: vi.fn(async () => undefined)
  };
  const cipher = new CredentialCipher(randomBytes(32).toString("base64"));
  const app = await buildApp({
    store,
    inlineProcessor,
    internalApiToken,
    wechatQrRateLimitMax,
    wechatRapidQrRateLimitMax: integration?.rapidQrRateLimitMax,
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
      cipher,
      sessionTtlMs
    },
    wechatWebRegistration: integration?.webRegistration
      ? {
          registrationUrl: "https://tomeet.chat/register",
          claimTtlMs: 15 * 60_000,
          accountProvisioner
        }
      : undefined
  });
  apps.push(app);
  return {
    app,
    store,
    wechatStore,
    fetchMock,
    verifyAccessToken,
    sentMessages,
    accountProvisioner,
    provisionedUserId,
    cipher
  };
}

function sentMessageTexts(messages: Array<Record<string, unknown>>): string[] {
  return messages.map((message) => {
    const msg = message.msg as { item_list?: Array<{ text_item?: { text?: string } }> };
    return msg.item_list?.[0]?.text_item?.text ?? "";
  });
}

describe("WeChat one-time QR onboarding", () => {
  it("fails closed instead of creating a public-only user when anonymous Auth provisioning fails", async () => {
    const owner = "wechat-owner-auth-provision-failure";
    const { app, store, accountProvisioner } = await setup([{
      status: "confirmed",
      bot_token: "failed-provision-bot-secret",
      ilink_bot_id: "failed-provision-bot",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: owner
    }], undefined, undefined, undefined, {
      webRegistration: true,
      provisionError: new Error("Anonymous sign-ins are disabled")
    });

    const created = (await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    })).json();
    const activated = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${created.sessionId}`,
      headers: { "x-wechat-session-token": created.sessionToken }
    });

    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({
      status: "failed",
      errorCode: "web_account_provision_failed"
    });
    expect(await store.resolveChannelIdentity("wechat", owner)).toBeNull();
    expect(accountProvisioner.provision).toHaveBeenCalledTimes(1);
    expect(accountProvisioner.discard).not.toHaveBeenCalled();
  });

  it("queues a complete welcome and registration link only for a newly created user", async () => {
    const internalApiToken = "web-registration-internal-token-32-chars";
    const provisionedUserId = randomUUID();
    const owner = "wechat-owner-web-registration";
    const {
      app,
      store,
      sentMessages,
      accountProvisioner,
      cipher
    } = await setup([{
      status: "confirmed",
      bot_token: "web-registration-bot-secret",
      ilink_bot_id: "web-registration-bot",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: owner
    }], internalApiToken, undefined, undefined, {
      webRegistration: true,
      provisionedUserId
    });
    const enqueueWelcome = vi.spyOn(store, "enqueueWechatOnboardingWelcome");

    const createdResponse = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const created = createdResponse.json();
    const activated = await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${created.sessionId}`,
      headers: { "x-wechat-session-token": created.sessionToken }
    });

    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ status: "active" });
    expect(await store.resolveChannelIdentity("wechat", owner))
      .toMatchObject({ userId: provisionedUserId });
    expect(accountProvisioner.provision).toHaveBeenCalledTimes(1);
    expect(accountProvisioner.discard).not.toHaveBeenCalled();

    expect(sentMessageTexts(sentMessages)).toEqual([]);
    expect(await store.ensureAdventurexOnboardingState(provisionedUserId)).toMatchObject({
      welcomeSentAt: expect.any(String),
      welcomeDeliveredAt: null
    });
    expect(enqueueWelcome).toHaveBeenCalledTimes(1);
    const [welcomeMessage, payloadCiphertext, claimId] = enqueueWelcome.mock.calls[0]!;
    const payload = JSON.parse(cipher.decrypt(
      payloadCiphertext,
      `wechat-welcome-delivery:${welcomeMessage.id}`
    )) as { bubbles: string[]; claimId: string | null };
    expect(payload.claimId).toBe(claimId);
    const texts = payload.bubbles;
    expect(texts.slice(0, 4)).toEqual(adventurexWelcomeBubbles.zh);
    expect(texts[4]).toBe("想在网页上和别人线下加好友吗，有机会上TOMEET“必吃榜”！");
    expect(texts[5]).toBe(
      "这是微信里的同一个 TOMEET 账号，网页只用于注册和加好友；Agent 对话和发起匹配仍在微信"
    );
    expect(texts[6]).toMatch(
      /^点这里为当前账号添加网页登录：https:\/\/tomeet\.chat\/register#claim=[A-Za-z0-9_-]{43}$/u
    );
    const token = texts[6]?.match(/#claim=([A-Za-z0-9_-]{43})$/u)?.[1];
    expect(token).toEqual(expect.any(String));
    expect(payloadCiphertext).not.toContain(token!);
    const delivered = await app.inject({
      method: "POST",
      url: `/internal/users/${provisionedUserId}/adventurex-onboarding/welcome-delivered`,
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { claimId }
    });
    expect(delivered.statusCode).toBe(200);
    const existingWechatMatch = await store.createMatchRequest(provisionedUserId, {
      rawText: "在微信里开始匹配"
    });

    const claim = await app.inject({
      method: "POST",
      url: "/auth/wechat/claim",
      payload: { token }
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.headers["cache-control"]).toContain("no-store");
    expect(claim.headers["referrer-policy"]).toBe("no-referrer");
    expect(claim.json()).toEqual({
      userId: provisionedUserId,
      session: {
        accessToken: "anonymous-access-token",
        refreshToken: "anonymous-refresh-token"
      },
      registrationMethods: ["email_password", "phone_password", "google"],
      accountContinuity: {
        mode: "upgrade_existing_wechat_user",
        preserves: ["conversation", "profile", "matching"]
      }
    });
    expect(await store.getLatestMatchRequestForUser(provisionedUserId))
      .toEqual(existingWechatMatch);

    const repeated = await app.inject({
      method: "POST",
      url: "/auth/wechat/claim",
      payload: { token }
    });
    expect(repeated.statusCode).toBe(401);
    expect(repeated.headers["cache-control"]).toContain("no-store");
    expect(repeated.headers["referrer-policy"]).toBe("no-referrer");
    expect(JSON.stringify(sentMessages)).not.toContain("anonymous-access-token");
    expect(JSON.stringify(sentMessages)).not.toContain("anonymous-refresh-token");
  });

  it("keeps the claim intact when the browser is signed in to a different account", async () => {
    const internalApiToken = "account-switch-internal-token-32-chars";
    const provisionedUserId = randomUUID();
    const otherUserId = randomUUID();
    const { app, store, cipher } = await setup([{
      status: "confirmed",
      bot_token: "account-switch-bot-secret",
      ilink_bot_id: "account-switch-bot",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "wechat-owner-account-switch"
    }], internalApiToken, undefined, undefined, {
      webRegistration: true,
      provisionedUserId,
      userByToken: { "other-account-token": otherUserId }
    });

    const created = (await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    })).json();
    const enqueueWelcome = vi.spyOn(store, "enqueueWechatOnboardingWelcome");
    await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${created.sessionId}`,
      headers: { "x-wechat-session-token": created.sessionToken }
    });
    const [welcomeMessage, payloadCiphertext, claimId] = enqueueWelcome.mock.calls[0]!;
    const payload = JSON.parse(cipher.decrypt(
      payloadCiphertext,
      `wechat-welcome-delivery:${welcomeMessage.id}`
    )) as { bubbles: string[] };
    const token = payload.bubbles[6]?.match(
      /#claim=([A-Za-z0-9_-]{43})$/u
    )?.[1];
    expect(token).toEqual(expect.any(String));
    await app.inject({
      method: "POST",
      url: `/internal/users/${provisionedUserId}/adventurex-onboarding/welcome-delivered`,
      headers: { "x-tomeet-internal-token": internalApiToken },
      payload: { claimId }
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/auth/wechat/claim",
      headers: { authorization: "Bearer other-account-token" },
      payload: { token }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: "wechat_web_account_switch_required"
    });

    const afterSignOut = await app.inject({
      method: "POST",
      url: "/auth/wechat/claim",
      payload: { token }
    });
    expect(afterSignOut.statusCode).toBe(200);
    expect(afterSignOut.json()).toMatchObject({ userId: provisionedUserId });
  });

  it("keeps one Web user and one welcome when the same WeChat account scans different QR codes", async () => {
    const internalApiToken = "multiple-qr-internal-token-32-characters";
    const owner = "wechat-owner-multiple-qr-codes";
    const confirmed = {
      status: "confirmed",
      bot_token: "first-bot-secret",
      ilink_bot_id: "first-bot",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: owner
    };
    const {
      app,
      store,
      sentMessages,
      accountProvisioner,
      provisionedUserId
    } = await setup([
      confirmed,
      {
        ...confirmed,
        bot_token: "rotated-bot-secret",
        ilink_bot_id: "second-bot"
      }
    ], internalApiToken, undefined, undefined, { webRegistration: true });
    const enqueueWelcome = vi.spyOn(store, "enqueueWechatOnboardingWelcome");

    for (let index = 0; index < 2; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/wechat/connect/sessions",
        payload: {}
      });
      const session = created.json();
      const activated = await app.inject({
        method: "GET",
        url: `/wechat/connect/sessions/${session.sessionId}`,
        headers: { "x-wechat-session-token": session.sessionToken }
      });
      expect(activated.json()).toMatchObject({ status: "active" });
    }

    expect(await store.resolveChannelIdentity("wechat", owner))
      .toMatchObject({ userId: provisionedUserId });
    expect(accountProvisioner.provision).toHaveBeenCalledTimes(1);
    expect(accountProvisioner.discard).not.toHaveBeenCalled();
    expect(sentMessageTexts(sentMessages)).toEqual([]);
    expect(enqueueWelcome).toHaveBeenCalledTimes(1);
    expect(await store.listRecentMessages(provisionedUserId)).toHaveLength(1);
  });

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

  it("caps roadshow QR issuance at one displayed code plus one standby", async () => {
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

    const firstResponse = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json();

    const concurrent = await Promise.all(Array.from({ length: 12 }, () => app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    })));
    expect(concurrent.every((response) => response.statusCode === 201)).toBe(true);
    const concurrentStandby = concurrent[0]!.json();
    expect(new Set(concurrent.map((response) => response.json().sessionId))).toEqual(
      new Set([concurrentStandby.sessionId])
    );
    expect(new Set(concurrent.map((response) => response.json().sessionToken))).toEqual(
      new Set([concurrentStandby.sessionToken])
    );
    expect(await wechatStore.getWechatSession(first.sessionId))
      .toMatchObject({ requestedUserId: null });

    const standby = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    });
    const duplicateStandby = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    });
    expect(standby.statusCode).toBe(201);
    expect(standby.json().sessionId).not.toBe(first.sessionId);
    expect(standby.json().sessionId).toBe(concurrentStandby.sessionId);
    expect(duplicateStandby.json().sessionId).toBe(standby.json().sessionId);

    await wechatStore.updateWechatSession(first.sessionId, { status: "scanned" });
    const replacement = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions/demo",
      headers: { authorization: "Bearer roadshow-token" },
      payload: {}
    });
    expect(replacement.statusCode).toBe(201);
    expect(replacement.json().sessionId).not.toBe(standby.json().sessionId);
    expect(replacement.json().qrCodeContent).toBe("weixin://connect/4");
    expect(await wechatStore.getWechatSession(replacement.json().sessionId))
      .toMatchObject({ requestedUserId: null });
  });

  it("keeps the roadshow QR endpoint bounded independently from public creation", async () => {
    const roadshowUserId = randomUUID();
    const { app } = await setup([], undefined, undefined, 1, {
      rapidQrTokens: ["roadshow-token"],
      rapidQrRateLimitMax: 2,
      userByToken: { "roadshow-token": roadshowUserId }
    });
    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/wechat/connect/sessions/demo",
        headers: { authorization: "Bearer roadshow-token" },
        payload: {}
      }));
    }
    expect(responses.slice(0, 2).every((response) => response.statusCode === 201)).toBe(true);
    expect(responses[2]?.statusCode).toBe(429);
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
    const enqueueWelcome = vi.spyOn(store, "enqueueWechatOnboardingWelcome");

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
    expect(enqueueWelcome).toHaveBeenCalledTimes(1);
    expect(sentMessageTexts(sentMessages)).toEqual([]);
    expect(await store.listRecentMessages(firstUserId)).toHaveLength(1);
    expect(await store.ensureAdventurexOnboardingState(firstUserId)).toMatchObject({
      preferredLanguage: "zh",
      welcomeSentAt: expect.any(String),
      welcomeDeliveredAt: null
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
    expect(enqueueWelcome).toHaveBeenCalledTimes(1);
    expect(sentMessageTexts(sentMessages)).toEqual([]);
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
    expect(sentMessageTexts(sentMessages)).toEqual([]);
    const identity = await store.resolveChannelIdentity("wechat", "wechat-owner-concurrent");
    expect(identity).not.toBeNull();
    expect(await store.listRecentMessages(identity!.userId)).toHaveLength(1);
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
      expect(sentMessageTexts(sentMessages)).toEqual([]);
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
      expect(sentMessageTexts(sentMessages)).toEqual([]);
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

  it("does not queue a welcome when the database user already exists", async () => {
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
    const enqueueWelcome = vi.spyOn(store, "enqueueWechatOnboardingWelcome");

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
    expect(enqueueWelcome).not.toHaveBeenCalled();
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

  it("includes decrypted active bot tokens in subsequent get_bot_qrcode calls", async () => {
    const statuses = [
      {
        status: "confirmed",
        bot_token: "tok-a",
        ilink_bot_id: "bot-a",
        baseurl: "https://ilink-api.example.com",
        ilink_user_id: "owner-a-local-tokens"
      },
      {
        status: "confirmed",
        bot_token: "tok-b",
        ilink_bot_id: "bot-b",
        baseurl: "https://ilink-api.example.com",
        ilink_user_id: "owner-b-local-tokens"
      }
    ];
    const { app, wechatStore, fetchMock } = await setup(statuses);

    const firstCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(firstCreate.statusCode).toBe(201);
    expect(qrLocalTokenLists(fetchMock)[0]).toEqual([]);

    const first = firstCreate.json();
    await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${first.sessionId}`,
      headers: { "x-wechat-session-token": first.sessionToken }
    });
    for (const connection of memoryConnections(wechatStore).values()) {
      if (connection.ownerIlinkUserId === "owner-a-local-tokens") {
        connection.updatedAt = "2026-07-26T00:00:01.000Z";
      }
    }

    const secondCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(secondCreate.statusCode).toBe(201);
    expect(qrLocalTokenLists(fetchMock).at(-1)).toEqual(["tok-a"]);

    const second = secondCreate.json();
    await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${second.sessionId}`,
      headers: { "x-wechat-session-token": second.sessionToken }
    });
    for (const connection of memoryConnections(wechatStore).values()) {
      if (connection.ownerIlinkUserId === "owner-b-local-tokens") {
        connection.updatedAt = "2026-07-26T00:00:02.000Z";
      }
    }

    const thirdCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(thirdCreate.statusCode).toBe(201);
    expect(qrLocalTokenLists(fetchMock).at(-1)).toEqual(["tok-b", "tok-a"]);
  });

  it("skips undecryptable active credentials when creating a QR session", async () => {
    const { app, wechatStore, fetchMock, cipher } = await setup([{
      status: "confirmed",
      bot_token: "good-token",
      ilink_bot_id: "bot-good",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "owner-good-decrypt"
    }]);

    const created = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const session = created.json();
    await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${session.sessionId}`,
      headers: { "x-wechat-session-token": session.sessionToken }
    });

    const connections = memoryConnections(wechatStore);
    const good = [...connections.values()][0]!;
    const badId = randomUUID();
    connections.set(badId, {
      ...good,
      id: badId,
      userId: randomUUID(),
      ownerIlinkUserId: "owner-bad-decrypt",
      botTokenCiphertext: "not-a-valid-ciphertext",
      updatedAt: "2026-07-26T00:00:03.000Z"
    });
    good.updatedAt = "2026-07-26T00:00:02.000Z";
    expect(() => cipher.decrypt(
      "not-a-valid-ciphertext",
      "wechat-connection:owner-bad-decrypt"
    )).toThrow();

    const next = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(next.statusCode).toBe(201);
    expect(qrLocalTokenLists(fetchMock).at(-1)).toEqual(["good-token"]);
  });

  it("caps local_token_list submitted to iLink at 10 active tokens", async () => {
    const statuses = Array.from({ length: 12 }, (_, index) => ({
      status: "confirmed",
      bot_token: `tok-${index}`,
      ilink_bot_id: `bot-${index}`,
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: `owner-cap-${index}`
    }));
    const { app, wechatStore, fetchMock } = await setup(statuses);

    for (let index = 0; index < 12; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/wechat/connect/sessions",
        payload: {}
      });
      const session = created.json();
      await app.inject({
        method: "GET",
        url: `/wechat/connect/sessions/${session.sessionId}`,
        headers: { "x-wechat-session-token": session.sessionToken }
      });
      for (const connection of memoryConnections(wechatStore).values()) {
        if (connection.ownerIlinkUserId === `owner-cap-${index}`) {
          connection.updatedAt = new Date(Date.UTC(2026, 6, 26, 0, 0, index)).toISOString();
        }
      }
    }

    const next = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(next.statusCode).toBe(201);
    expect(qrLocalTokenLists(fetchMock).at(-1)).toEqual(
      Array.from({ length: 10 }, (_, index) => `tok-${11 - index}`)
    );
  });

  it("keeps one connection row when the same WeChat identity reconnects", async () => {
    const confirmed = {
      status: "confirmed",
      bot_token: "bot-secret-1",
      ilink_bot_id: "bot-1",
      baseurl: "https://ilink-api.example.com",
      ilink_user_id: "owner-upsert-once"
    };
    const { app, wechatStore, fetchMock } = await setup([
      confirmed,
      { ...confirmed, bot_token: "bot-secret-2", ilink_bot_id: "bot-2" }
    ]);

    const firstCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    const first = firstCreate.json();
    await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${first.sessionId}`,
      headers: { "x-wechat-session-token": first.sessionToken }
    });
    const before = await wechatStore.listActiveWechatConnectionsForQr(10);
    expect(before).toHaveLength(1);
    const connectionId = before[0]!.id;

    const secondCreate = await app.inject({
      method: "POST",
      url: "/wechat/connect/sessions",
      payload: {}
    });
    expect(qrLocalTokenLists(fetchMock).at(-1)).toEqual(["bot-secret-1"]);
    const second = secondCreate.json();
    await app.inject({
      method: "GET",
      url: `/wechat/connect/sessions/${second.sessionId}`,
      headers: { "x-wechat-session-token": second.sessionToken }
    });

    const after = await wechatStore.listActiveWechatConnectionsForQr(10);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: connectionId,
      ownerIlinkUserId: "owner-upsert-once",
      ilinkBotId: "bot-2"
    });
  });
});
