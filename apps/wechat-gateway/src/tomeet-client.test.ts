import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TomeetApiClient } from "./tomeet-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function completedJob() {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    type: "agent_reply",
    status: "completed",
    payload: {},
    result: {},
    error: null,
    attempts: 1,
    maxAttempts: 3,
    partitionKey: null,
    createdAt: now,
    updatedAt: now
  };
}

describe("TomeetApiClient", () => {
  it("returns null for an unlinked WeChat identity", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "channel_identity_unlinked",
          message: "not linked"
        },
        404
      )
    );
    const client = new TomeetApiClient({
      baseUrl: "http://localhost:4000",
      internalApiToken: "x".repeat(32)
    });
    await expect(client.resolveWeChatIdentity("wxid_unlinked")).resolves.toBeNull();
  });

  it("sends through the resolved TOMEET profile and returns the latest reply", async () => {
    const userId = randomUUID();
    const identity = {
      provider: "wechat" as const,
      externalUserId: "wxid_linked",
      userId,
      displayName: "Linked User",
      linkedAt: new Date().toISOString()
    };
    const now = new Date().toISOString();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ job: completedJob() }))
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            {
              id: randomUUID(),
              userId,
              role: "user",
              content: "hello",
              createdAt: now
            },
            {
              id: randomUUID(),
              userId,
              role: "assistant",
              content: "hello from TOMEET",
              createdAt: now
            }
          ]
        })
      );
    const client = new TomeetApiClient({
      baseUrl: "http://localhost:4000",
      internalApiToken: "x".repeat(32)
    });
    await expect(
      client.sendText({
        identity,
        displayName: "Linked User",
        content: "hello",
        channelMessageId: "wechat-message-1"
      })
    ).resolves.toBe("hello from TOMEET");
  });
});
