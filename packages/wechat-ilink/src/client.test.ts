import { describe, expect, it, vi } from "vitest";
import { WechatILinkClient } from "./client.js";

describe("WechatILinkClient", () => {
  it("uses the official QR login request shape", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({
        qrcode: "qr-secret",
        qrcode_img_content: "weixin://login/content"
      }));
    });
    const client = new WechatILinkClient({ fetch: fetchMock as typeof fetch });

    await expect(client.createLoginQr()).resolves.toEqual({
      qrCode: "qr-secret",
      qrCodeContent: "weixin://login/content"
    });
    expect(requestedUrl).toContain("ilink/bot/get_bot_qrcode?bot_type=3");
    expect(JSON.parse(String(requestedInit?.body))).toEqual({ local_token_list: [] });
    expect(new Headers(requestedInit?.headers).get("iLink-App-Id")).toBe("bot");
  });

  it("sends a completed bot text message with the inbound context", async () => {
    let requestedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedInit = init;
      return new Response(JSON.stringify({ ret: 0 }));
    });
    const client = new WechatILinkClient({ fetch: fetchMock as typeof fetch });

    await client.sendText({
      baseUrl: "https://api.example.com",
      botToken: "bot-secret",
      toUserId: "wx-user",
      text: "你好",
      contextToken: "context",
      runId: "run"
    });

    const body = JSON.parse(String(requestedInit?.body));
    expect(body.msg).toMatchObject({
      to_user_id: "wx-user",
      message_type: 2,
      message_state: 2,
      context_token: "context",
      run_id: "run",
      item_list: [{ type: 1, text_item: { text: "你好" } }]
    });
    expect(body.base_info).toEqual({
      channel_version: "2.4.6",
      bot_agent: "TOMEET/0.1.0"
    });
    expect(new Headers(requestedInit?.headers).get("Authorization")).toBe("Bearer bot-secret");
  });

  it("extracts text and voice transcription only", () => {
    expect(WechatILinkClient.extractText({
      item_list: [
        { type: 2 },
        { type: 1, text_item: { text: "第一段" } },
        { type: 3, voice_item: { text: "语音转写" } }
      ]
    })).toBe("第一段\n语音转写");
  });

  it("treats transient QR polling failures as a wait state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("gateway timeout", { status: 524 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = new WechatILinkClient({ fetch: fetchMock as typeof fetch });

    await expect(client.pollLoginQr({ qrCode: "qr-1" }))
      .resolves.toEqual({ status: "wait" });
    await expect(client.pollLoginQr({ qrCode: "qr-1" }))
      .resolves.toEqual({ status: "wait" });
  });

  it("rejects unsafe base URLs and unknown protocol states", async () => {
    expect(() => new WechatILinkClient({ qrBaseUrl: "http://example.com" }))
      .toThrow("must use HTTPS");
    expect(() => new WechatILinkClient({ qrBaseUrl: "http://127.0.0.1:6174" }))
      .toThrow("must use HTTPS");
    expect(() => new WechatILinkClient({
      qrBaseUrl: "https://user:password@example.com"
    })).toThrow("must not contain credentials");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "new-upstream-state"
    })));
    const client = new WechatILinkClient({ fetch: fetchMock as typeof fetch });
    await expect(client.pollLoginQr({ qrCode: "qr-1" }))
      .rejects.toThrow("unknown QR status");
  });
});
