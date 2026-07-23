import { randomBytes, randomUUID } from "node:crypto";
import { MemoryStore, MemoryWechatStore } from "@tomeet/data";
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
  sessionTtlMs?: number
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
  const verifyAccessToken = vi.fn(async () => {
    throw new Error("WeChat route unexpectedly required a bearer token");
  });
  const app = await buildApp({
    store,
    internalApiToken,
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
