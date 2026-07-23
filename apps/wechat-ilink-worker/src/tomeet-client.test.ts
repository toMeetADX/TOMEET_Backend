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
});
