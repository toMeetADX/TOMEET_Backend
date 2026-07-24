import { randomBytes } from "node:crypto";
import { adventurexWelcomeBubbles, adventurexWelcomeContent } from "@tomeet/contracts";
import type { WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  type WechatConnection,
  type WechatOutboundDelivery
} from "@tomeet/wechat-ilink";
import { describe, expect, it, vi } from "vitest";
import {
  deliverWechatOutboundMessage,
  handleWechatMessage,
  monitorWechatConnection,
  splitWechatBubbles,
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
    sendText: vi.fn(async () => "Agent reply"),
    sendEvent: vi.fn(async () => "Agent event reply")
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
  it("splits ordinary replies into short bubbles while preserving cards", () => {
    expect(splitWechatBubbles(adventurexWelcomeContent("zh"))).toEqual(adventurexWelcomeBubbles.zh);
    expect(splitWechatBubbles("第一句话。第二句话！\n\nThird sentence.")).toEqual([
      "第一句话",
      "第二句话！",
      "Third sentence"
    ]);
    const card = [
      "┏━━━━━━━━━━━━",
      "┃ TOMEET 成局确认函",
      "┣━━━━━━━━━━━━",
      "┃ 👥 4 人",
      "┃ 📍 TOMEET 集合点",
      "┗━━━━━━━━━━━━"
    ].join("\n");
    expect(splitWechatBubbles(card)).toEqual([card]);
  });

  it("delivers proactive outbox messages without logging content or credentials", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    const completeWechatOutboundMessage = vi.fn(async () => undefined);
    const delivery: WechatOutboundDelivery = {
      id: "27000000-0000-4000-8000-000000000001",
      messageId: "27000000-0000-4000-8000-000000000002",
      userId: activeConnection.userId,
      content: "有一个适合你的新候选局",
      attempts: 1,
      connection: activeConnection
    };

    await deliverWechatOutboundMessage({
      store: { completeWechatOutboundMessage },
      cipher: runtime.cipher,
      ilink: runtime.ilink,
      logger: runtime.logger
    }, delivery, "worker-1");

    expect(runtime.ilink.sendText).toHaveBeenCalledWith({
      baseUrl: activeConnection.baseUrl,
      botToken: "bot-secret",
      toUserId: activeConnection.ownerIlinkUserId,
      text: delivery.content,
      runId: `outbound-${delivery.id}-bubble-1`
    });
    expect(completeWechatOutboundMessage).toHaveBeenCalledWith(delivery.id, "worker-1");
    expect(JSON.stringify(runtime.logger.info.mock.calls)).not.toContain(delivery.content);
    expect(JSON.stringify(runtime.logger.info.mock.calls)).not.toContain("bot-secret");
  });

  it("delivers the welcome as four sequential bubbles with stable run ids", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    const completeWechatOutboundMessage = vi.fn(async () => undefined);
    const delivery: WechatOutboundDelivery = {
      id: "27000000-0000-4000-8000-000000000011",
      messageId: "27000000-0000-4000-8000-000000000012",
      userId: activeConnection.userId,
      content: adventurexWelcomeContent("zh"),
      attempts: 1,
      connection: activeConnection
    };

    await deliverWechatOutboundMessage({
      store: { completeWechatOutboundMessage },
      cipher: runtime.cipher,
      ilink: runtime.ilink,
      logger: runtime.logger,
      bubbleDelayMs: 0
    }, delivery, "worker-1");

    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.text))
      .toEqual(adventurexWelcomeBubbles.zh);
    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.runId)).toEqual([
      `outbound-${delivery.id}-bubble-1`,
      `outbound-${delivery.id}-bubble-2`,
      `outbound-${delivery.id}-bubble-3`,
      `outbound-${delivery.id}-bubble-4`
    ]);
    expect(completeWechatOutboundMessage).toHaveBeenCalledTimes(1);
  });

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

  it("sends a multi-sentence Agent reply one bubble at a time", async () => {
    const runtime = setup();
    runtime.tomeet.sendText.mockResolvedValue("先确认一下。你更想认识做产品的人吗？\n\n也可以继续说说你的雷点。");
    const activeConnection = connection(runtime.cipher);

    await handleWechatMessage(runtime.dependencies, activeConnection, "bot-secret", {
      message_id: 44,
      message_type: 1,
      from_user_id: activeConnection.ownerIlinkUserId,
      context_token: "context-4",
      run_id: "wechat-run-44",
      item_list: [{ type: 1, text_item: { text: "继续" } }]
    });

    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "先确认一下",
      "你更想认识做产品的人吗？",
      "也可以继续说说你的雷点"
    ]);
    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.runId)).toEqual([
      "wechat-run-44-bubble-1",
      "wechat-run-44-bubble-2",
      "wechat-run-44-bubble-3"
    ]);
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

  it("asks the Agent to compose the reply for unsupported message content", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);

    await expect(handleWechatMessage(
      runtime.dependencies,
      activeConnection,
      "bot-secret",
      {
        message_id: 43,
        message_type: 1,
        from_user_id: activeConnection.ownerIlinkUserId,
        context_token: "context-2",
        item_list: [{ type: 2 }]
      }
    )).resolves.toBe(true);

    expect(runtime.tomeet.sendEvent).toHaveBeenCalledWith({
      connectionId: activeConnection.id,
      messageId: "43",
      userId: activeConnection.userId,
      event: {
        kind: "unsupported_channel_message",
        facts: {
          channel: "wechat",
          supportedInputs: ["text", "transcribed_audio"],
          receivedMessageType: 1
        }
      }
    });
    expect(runtime.tomeet.sendText).not.toHaveBeenCalled();
    expect(runtime.ilink.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Agent event reply" })
    );
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
