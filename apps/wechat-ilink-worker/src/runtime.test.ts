import { randomBytes } from "node:crypto";
import type { WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  type WechatConnection
} from "@tomeet/wechat-ilink";
import { describe, expect, it, vi } from "vitest";
import {
  handleWechatMessage,
  monitorWechatConnection,
  type AgentTextClient,
  type WechatRuntimeDependencies,
  type WechatTransport,
  type WorkerLogger
} from "./runtime.js";

function connection(cipher: CredentialCipher): WechatConnection {
  const now = new Date().toISOString();
  return {
    id: "26000000-0000-4000-8000-000000000001",
    userId: "26000000-0000-4000-8000-000000000002",
    ilinkBotId: "bot-1",
    ownerIlinkUserId: "wechat-owner-1",
    botTokenCiphertext: cipher.encrypt(
      "bot-secret",
      "wechat-connection:wechat-owner-1"
    ),
    baseUrl: "https://ilink.example.com",
    syncCursor: "",
    status: "active",
    leaseOwner: "worker-1",
    leaseExpiresAt: now,
    lastMessageAt: null,
    lastError: null,
    failureCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

function setup() {
  const store = {
    beginWechatMessage: vi.fn(async () => true),
    completeWechatMessage: vi.fn(async () => undefined),
    markWechatConnectionError: vi.fn(async () => undefined),
    releaseWechatConnection: vi.fn(async () => undefined),
    renewWechatConnectionLease: vi.fn(async () => true),
    updateWechatConnectionCursor: vi.fn(async () => false)
  } satisfies Partial<WechatConnectionStore>;
  const ilink = {
    getUpdates: vi.fn<WechatTransport["getUpdates"]>(async () => ({
      ret: 0,
      msgs: [],
      get_updates_buf: ""
    })),
    sendText: vi.fn<WechatTransport["sendText"]>(async () => "client-1")
  } satisfies WechatTransport;
  const tomeet = {
    sendText: vi.fn(async () => "Agent reply")
  } satisfies AgentTextClient;
  const logger = {
    info: vi.fn(),
    error: vi.fn()
  } satisfies WorkerLogger;
  const cipher = new CredentialCipher(randomBytes(32).toString("base64"));
  const dependencies: WechatRuntimeDependencies = {
    store: store as WechatRuntimeDependencies["store"],
    ilink,
    tomeet,
    logger,
    cipher
  };
  return { store, ilink, tomeet, logger, cipher, dependencies };
}

describe("WeChat worker runtime", () => {
  it("forwards one user message and completes its idempotency receipt", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);

    await expect(handleWechatMessage(
      runtime.dependencies,
      activeConnection,
      "bot-secret",
      {
        message_id: 42,
        message_type: 1,
        from_user_id: activeConnection.ownerIlinkUserId,
        context_token: "context-1",
        item_list: [{ type: 1, text_item: { text: "你好" } }]
      }
    )).resolves.toBe(true);

    expect(runtime.tomeet.sendText).toHaveBeenCalledWith({
      connectionId: activeConnection.id,
      messageId: "42",
      userId: activeConnection.userId,
      content: "你好"
    });
    expect(runtime.ilink.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        botToken: "bot-secret",
        text: "Agent reply",
        contextToken: "context-1"
      })
    );
    expect(runtime.store.completeWechatMessage).toHaveBeenCalledWith(
      activeConnection.id,
      "42"
    );
    expect(JSON.stringify(runtime.logger.info.mock.calls)).not.toContain("你好");
    expect(JSON.stringify(runtime.logger.info.mock.calls)).not.toContain("bot-secret");
  });

  it("does not execute a duplicate receipt", async () => {
    const runtime = setup();
    runtime.store.beginWechatMessage.mockResolvedValue(false);
    const activeConnection = connection(runtime.cipher);

    await expect(handleWechatMessage(
      runtime.dependencies,
      activeConnection,
      "bot-secret",
      {
        message_id: 42,
        message_type: 1,
        from_user_id: activeConnection.ownerIlinkUserId,
        item_list: [{ type: 1, text_item: { text: "duplicate" } }]
      }
    )).resolves.toBe(false);

    expect(runtime.tomeet.sendText).not.toHaveBeenCalled();
    expect(runtime.ilink.sendText).not.toHaveBeenCalled();
  });

  it("marks iLink -14 as requiring a fresh QR authorization", async () => {
    const runtime = setup();
    runtime.ilink.getUpdates.mockResolvedValue({
      ret: -14,
      errmsg: "session timeout"
    });
    const activeConnection = connection(runtime.cipher);

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: new AbortController().signal
    });

    expect(runtime.store.markWechatConnectionError).toHaveBeenCalledWith({
      connectionId: activeConnection.id,
      workerId: "worker-1",
      message: "iLink getUpdates failed (-14): session timeout",
      reauthRequired: true
    });
    expect(runtime.store.releaseWechatConnection).toHaveBeenCalled();
    expect(JSON.stringify(runtime.logger.error.mock.calls)).not.toContain("bot-secret");
  });

  it("persists the cursor only while the worker still owns the lease", async () => {
    const runtime = setup();
    runtime.ilink.getUpdates.mockResolvedValue({
      ret: 0,
      msgs: [],
      get_updates_buf: "cursor-2"
    });
    const activeConnection = connection(runtime.cipher);

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: new AbortController().signal
    });

    expect(runtime.store.renewWechatConnectionLease).toHaveBeenCalledWith(
      activeConnection.id,
      "worker-1",
      300
    );
    expect(runtime.store.updateWechatConnectionCursor).toHaveBeenCalledWith(
      activeConnection.id,
      "worker-1",
      "cursor-2",
      undefined
    );
    expect(runtime.store.releaseWechatConnection).toHaveBeenCalled();
  });
});
