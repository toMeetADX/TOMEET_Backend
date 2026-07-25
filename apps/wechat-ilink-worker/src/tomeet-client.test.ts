import { afterEach, describe, expect, it, vi } from "vitest";
import { TomeetClient } from "./tomeet-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function completedJob(reply: string) {
  const now = new Date().toISOString();
  return {
    id: "job-1",
    type: "agent_reply",
    status: "completed",
    payload: {},
    result: {
      message: {
        id: "reply-1",
        userId: "25000000-0000-4000-8000-000000000001",
        role: "assistant",
        content: reply,
        createdAt: now
      }
    },
    error: null,
    attempts: 1,
    maxAttempts: 3,
    partitionKey: "user:25000000-0000-4000-8000-000000000001",
    createdAt: now,
    updatedAt: now
  };
}

describe("TomeetClient", () => {
  it("claims the persisted onboarding welcome for the first WeChat message", async () => {
    const now = new Date().toISOString();
    let requestedUrl = "";
    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        message: {
          id: "welcome-1",
          userId: "25000000-0000-4000-8000-000000000001",
          role: "assistant",
          content: "你好呀👋",
          sourceChannel: "system",
          replyToMessageId: null,
          createdAt: now
        }
      }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TomeetClient({
      baseUrl: "https://api.example.com",
      internalApiToken: "internal-test-token"
    });

    await expect(client.startOnboarding({
      userId: "25000000-0000-4000-8000-000000000001"
    })).resolves.toBe("你好呀👋");
    expect(requestedUrl).toBe(
      "https://api.example.com/internal/users/25000000-0000-4000-8000-000000000001/adventurex-onboarding/start"
    );
    expect(postedBody).toEqual({ language: "zh" });
  });

  it("returns the assistant message directly from a completed job", async () => {
    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ job: completedJob("微信回复") }), {
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TomeetClient({
      baseUrl: "https://api.example.com",
      internalApiToken: "internal-test-token"
    });

    await expect(client.sendText({
      connectionId: "connection-1",
      messageId: "message-1",
      userId: "25000000-0000-4000-8000-000000000001",
      content: "你好"
    })).resolves.toBe("微信回复");
    expect(postedBody).toMatchObject({
      userId: "25000000-0000-4000-8000-000000000001",
      content: "你好"
    });
    expect(String(postedBody?.idempotencyKey)).toMatch(/^wechat:[a-f0-9]{64}$/);
  });

  it("polls a queued job before returning its reply", async () => {
    const now = new Date().toISOString();
    let requestCount = 0;
    const fetchMock = vi.fn(async () => {
      requestCount += 1;
      const job = requestCount === 1
        ? {
            ...completedJob("稍后回复"),
            status: "pending",
            result: null,
            attempts: 0
          }
        : completedJob("稍后回复");
      return new Response(JSON.stringify({ job }), {
        headers: { "Content-Type": "application/json", "x-test-time": now }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TomeetClient({
      baseUrl: "https://api.example.com",
      internalApiToken: "internal-test-token",
      pollIntervalMs: 1,
      pollAttempts: 2
    });

    await expect(client.sendText({
      connectionId: "connection-2",
      messageId: "message-2",
      userId: "25000000-0000-4000-8000-000000000001",
      content: "排队"
    })).resolves.toBe("稍后回复");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("submits an image batch as one multimodal job", async () => {
    let requestedUrl = "";
    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        job: { ...completedJob("两张图片放在一起看，最吸引你的是哪一处？"), type: "multimodal_understanding" }
      }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TomeetClient({
      baseUrl: "https://api.example.com",
      internalApiToken: "internal-test-token"
    });

    await expect(client.sendImages({
      connectionId: "connection-images",
      generationToken: "generation-images",
      userId: "25000000-0000-4000-8000-000000000001",
      images: [
        { messageId: "image-1", bytes: Uint8Array.from([1, 2]), mimeType: "image/jpeg" },
        { messageId: "image-2", bytes: Uint8Array.from([3, 4]), mimeType: "image/png" }
      ],
      turns: [
        { messageId: "image-1", imageCount: 1 },
        { messageId: "image-2", imageCount: 1 }
      ]
    })).resolves.toEqual({
      reply: "两张图片放在一起看，最吸引你的是哪一处？",
      stale: false
    });
    expect(requestedUrl).toBe("https://api.example.com/internal/agent/multimodal-inputs");
    expect(postedBody).toMatchObject({
      userId: "25000000-0000-4000-8000-000000000001",
      connectionId: "connection-images",
      generationToken: "generation-images",
      images: [
        { messageId: "image-1", dataBase64: "AQI=", mimeType: "image/jpeg" },
        { messageId: "image-2", dataBase64: "AwQ=", mimeType: "image/png" }
      ],
      turns: [
        { messageId: "image-1", imageCount: 1, idempotencyKey: expect.stringMatching(/^wechat:[a-f0-9]{64}$/) },
        { messageId: "image-2", imageCount: 1, idempotencyKey: expect.stringMatching(/^wechat:[a-f0-9]{64}$/) }
      ]
    });
    expect(String(postedBody?.idempotencyKey)).toMatch(/^wechat:[a-f0-9]{64}$/);
  });

  it("never substitutes a shared Web history message for a missing WeChat reply", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      job: { ...completedJob("unused"), result: {} }
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TomeetClient({
      baseUrl: "https://api.example.com",
      internalApiToken: "internal-test-token"
    });

    await expect(client.sendText({
      connectionId: "connection-2",
      messageId: "message-without-reply",
      userId: "25000000-0000-4000-8000-000000000001",
      content: "不要拿网页回复兜底"
    })).rejects.toMatchObject({ code: "assistant_reply_missing" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("submits unsupported channel content as a structured Agent event", async () => {
    let requestedUrl = "";
    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        job: { ...completedJob("请换成文字告诉我"), type: "agent_event_reply" }
      }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TomeetClient({
      baseUrl: "https://api.example.com",
      internalApiToken: "internal-test-token"
    });

    await expect(client.sendEvent({
      connectionId: "connection-3",
      messageId: "message-3",
      userId: "25000000-0000-4000-8000-000000000001",
      event: {
        kind: "unsupported_channel_message",
        facts: { channel: "wechat", supportedInputs: ["text"] }
      }
    })).resolves.toBe("请换成文字告诉我");

    expect(requestedUrl).toBe("https://api.example.com/internal/agent/events");
    expect(postedBody).toMatchObject({
      userId: "25000000-0000-4000-8000-000000000001",
      event: {
        kind: "unsupported_channel_message",
        facts: { channel: "wechat", supportedInputs: ["text"] }
      }
    });
    expect(String(postedBody?.idempotencyKey)).toMatch(/^wechat:[a-f0-9]{64}$/);
  });
});
