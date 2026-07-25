import { randomBytes } from "node:crypto";
import {
  adventurexWelcomeBubbles,
  adventurexWelcomeContent,
  channelTurnFailureNotice
} from "@tomeet/contracts";
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
    startOnboarding: vi.fn<AgentTextClient["startOnboarding"]>(async () => null),
    setResponseGeneration: vi.fn(async () => undefined),
    sendTextBatch: vi.fn<AgentTextClient["sendTextBatch"]>(async () => ({
      reply: "Agent reply",
      stale: false
    })),
    sendText: vi.fn(async () => "Agent reply"),
    sendImages: vi.fn<AgentTextClient["sendImages"]>(async () => ({
      reply: "Image batch reply",
      stale: false
    })),
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
    expect(adventurexWelcomeBubbles.zh[1]).toBe("很高兴认识你");
    expect(adventurexWelcomeBubbles.en[1]).toBe("Nice to meet you");
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

    expect(runtime.tomeet.sendTextBatch).toHaveBeenCalledWith({
      connectionId: activeConnection.id,
      generationToken: expect.any(String),
      messageIds: ["42"],
      userId: activeConnection.userId,
      contents: ["你好"]
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

  it("sends the onboarding welcome before the first Agent reply and only once", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.tomeet.startOnboarding.mockResolvedValue(adventurexWelcomeContent("zh"));

    await handleWechatMessage(runtime.dependencies, activeConnection, "bot-secret", {
      message_id: 45,
      message_type: 1,
      from_user_id: activeConnection.ownerIlinkUserId,
      context_token: "context-first",
      item_list: [{ type: 1, text_item: { text: "开始" } }]
    });

    expect(runtime.tomeet.startOnboarding).toHaveBeenCalledTimes(1);
    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.text)).toEqual([
      ...adventurexWelcomeBubbles.zh,
      "Agent reply"
    ]);
    expect(runtime.ilink.sendText.mock.calls.slice(0, 4).map(([input]) => input.runId)).toEqual([
      `first-inbound-welcome-${activeConnection.id}-45-bubble-1`,
      `first-inbound-welcome-${activeConnection.id}-45-bubble-2`,
      `first-inbound-welcome-${activeConnection.id}-45-bubble-3`,
      `first-inbound-welcome-${activeConnection.id}-45-bubble-4`
    ]);
    expect(activeConnection.lastMessageAt).not.toBeNull();

    runtime.tomeet.startOnboarding.mockClear();
    runtime.ilink.sendText.mockClear();
    await handleWechatMessage(runtime.dependencies, activeConnection, "bot-secret", {
      message_id: 46,
      message_type: 1,
      from_user_id: activeConnection.ownerIlinkUserId,
      context_token: "context-second",
      item_list: [{ type: 1, text_item: { text: "第二条" } }]
    });

    expect(runtime.tomeet.startOnboarding).not.toHaveBeenCalled();
    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "Agent reply"
    ]);
  });

  it("groups multiple inbound image messages into one vision request and one reply", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.ilink.getUpdates.mockResolvedValueOnce({
      ret: 0,
      get_updates_buf: "cursor-1",
      msgs: [
        {
          message_id: 51,
          message_type: 1,
          from_user_id: activeConnection.ownerIlinkUserId,
          context_token: "context-51",
          item_list: [{
            type: 2,
            image_item: { media: { encrypt_query_param: "image-1" } }
          }]
        },
        {
          message_id: 52,
          message_type: 1,
          from_user_id: activeConnection.ownerIlinkUserId,
          context_token: "context-52",
          item_list: [{
            type: 2,
            image_item: { media: { encrypt_query_param: "image-2" } }
          }]
        }
      ]
    });
    runtime.dependencies.downloadImage = vi.fn(async (item) => ({
      bytes: Uint8Array.from([Number(item.image_item?.media?.encrypt_query_param?.at(-1))]),
      mimeType: "image/jpeg" as const
    }));

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: new AbortController().signal,
      turnBatchWindowMs: 10_000
    });

    expect(runtime.tomeet.sendImages).toHaveBeenCalledTimes(1);
    expect(runtime.tomeet.sendImages).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: activeConnection.id,
      generationToken: expect.any(String),
      messageIds: ["51", "52"],
      userId: activeConnection.userId,
      images: [
        { bytes: Uint8Array.from([1]), mimeType: "image/jpeg" },
        { bytes: Uint8Array.from([2]), mimeType: "image/jpeg" }
      ]
    }));
    expect(runtime.ilink.sendText).toHaveBeenCalledTimes(1);
    expect(runtime.ilink.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "Image batch reply",
      contextToken: "context-52"
    }));
    expect(runtime.store.completeWechatMessage).toHaveBeenCalledWith(activeConnection.id, "51");
    expect(runtime.store.completeWechatMessage).toHaveBeenCalledWith(activeConnection.id, "52");
  });

  it("re-analyzes an active image batch together with all newer messages", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    let markImageStarted!: () => void;
    const imageStarted = new Promise<void>((resolve) => {
      markImageStarted = resolve;
    });
    let resolveFirstVision!: (result: { reply: string; stale: boolean }) => void;
    const firstVision = new Promise<{ reply: string; stale: boolean }>((resolve) => {
      resolveFirstVision = resolve;
    });
    let generationRegistrations = 0;
    runtime.tomeet.setResponseGeneration.mockImplementation(async () => {
      generationRegistrations += 1;
      if (generationRegistrations === 2) {
        resolveFirstVision({ reply: "Outdated image reply", stale: false });
      }
      if (generationRegistrations === 3) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    runtime.tomeet.sendImages
      .mockImplementationOnce(async () => {
        markImageStarted();
        return firstVision;
      })
      .mockResolvedValueOnce({ reply: "Combined image and text reply", stale: false });
    runtime.dependencies.downloadImage = vi.fn(async () => ({
      bytes: Uint8Array.from([7]),
      mimeType: "image/jpeg" as const
    }));
    let updatePoll = 0;
    runtime.ilink.getUpdates.mockImplementation(async () => {
      updatePoll += 1;
      if (updatePoll === 1) {
        return {
          ret: 0,
          get_updates_buf: "cursor-image",
          msgs: [{
            message_id: 71,
            message_type: 1,
            from_user_id: activeConnection.ownerIlinkUserId,
            item_list: [{
              type: 2,
              image_item: { media: { encrypt_query_param: "image-7" } }
            }]
          }]
        };
      }
      await imageStarted;
      return {
        ret: 0,
        get_updates_buf: "cursor-text-after-image",
        msgs: [
          {
            message_id: 72,
            message_type: 1,
            from_user_id: activeConnection.ownerIlinkUserId,
            item_list: [{ type: 1, text_item: { text: "这张照片是我上周拍的" } }]
          },
          {
            message_id: 73,
            message_type: 1,
            from_user_id: activeConnection.ownerIlinkUserId,
            context_token: "context-73",
            item_list: [{ type: 1, text_item: { text: "是在苏州河边" } }]
          }
        ]
      };
    });
    runtime.store.updateWechatConnectionCursor
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: new AbortController().signal,
      turnBatchWindowMs: 0
    });

    expect(runtime.tomeet.sendImages).toHaveBeenCalledTimes(2);
    expect(runtime.tomeet.sendImages.mock.calls[1]?.[0]).toMatchObject({
      messageIds: ["71", "72", "73"],
      images: [{ bytes: Uint8Array.from([7]), mimeType: "image/jpeg" }],
      hint: "这张照片是我上周拍的\n是在苏州河边"
    });
    expect(runtime.ilink.sendText).toHaveBeenCalledTimes(1);
    expect(runtime.ilink.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "Combined image and text reply",
      contextToken: "context-73"
    }));
  });

  it("groups consecutive text bubbles into one Agent turn", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.ilink.getUpdates.mockResolvedValueOnce({
      ret: 0,
      get_updates_buf: "cursor-text",
      msgs: [
        {
          message_id: 61,
          message_type: 1,
          from_user_id: activeConnection.ownerIlinkUserId,
          item_list: [{ type: 1, text_item: { text: "我平时喜欢拍城市夜景" } }]
        },
        {
          message_id: 62,
          message_type: 1,
          from_user_id: activeConnection.ownerIlinkUserId,
          context_token: "context-62",
          item_list: [{ type: 1, text_item: { text: "最近也在学胶片摄影" } }]
        }
      ]
    });

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: new AbortController().signal,
      turnBatchWindowMs: 10_000
    });

    expect(runtime.tomeet.sendTextBatch).toHaveBeenCalledTimes(1);
    expect(runtime.tomeet.sendTextBatch).toHaveBeenCalledWith(expect.objectContaining({
      messageIds: ["61", "62"],
      contents: ["我平时喜欢拍城市夜景", "最近也在学胶片摄影"]
    }));
    expect(runtime.ilink.sendText).toHaveBeenCalledTimes(1);
  });

  it("sends a multi-sentence Agent reply one bubble at a time", async () => {
    const runtime = setup();
    runtime.tomeet.sendTextBatch.mockResolvedValue({
      reply: "先确认一下。你更想认识做产品的人吗？\n\n也可以继续说说你的雷点。",
      stale: false
    });
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

    expect(runtime.tomeet.sendTextBatch).not.toHaveBeenCalled();
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
        item_list: [{ type: 9 }]
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
          supportedInputs: ["text", "image", "transcribed_audio"],
          receivedMessageType: 1
        }
      }
    });
    expect(runtime.tomeet.sendText).not.toHaveBeenCalled();
    expect(runtime.ilink.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Agent event reply" })
    );
  });

  it("reports an unreadable picture as received instead of unsupported", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.dependencies.downloadImage = vi.fn(async () => {
      throw new Error("微信图片缺少 CDN 下载参数");
    });

    await expect(handleWechatMessage(
      runtime.dependencies,
      activeConnection,
      "bot-secret",
      {
        message_id: 81,
        message_type: 1,
        from_user_id: activeConnection.ownerIlinkUserId,
        context_token: "context-81",
        item_list: [{ type: 2, image_item: { thumb_media: {} } }]
      }
    )).resolves.toBe(true);

    expect(runtime.tomeet.sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: {
        kind: "channel_media_unreadable",
        facts: { channel: "wechat", receivedKinds: ["image"], unreadableCount: 1 }
      }
    }));
    expect(runtime.tomeet.sendImages).not.toHaveBeenCalled();
  });

  it("still answers the accompanying text when one picture of a turn is unreadable", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.dependencies.downloadImage = vi.fn(async () => {
      throw new Error("微信图片下载失败 (404)");
    });

    await expect(handleWechatMessage(
      runtime.dependencies,
      activeConnection,
      "bot-secret",
      {
        message_id: 82,
        message_type: 1,
        from_user_id: activeConnection.ownerIlinkUserId,
        item_list: [
          { type: 1, text_item: { text: "看看这张" } },
          { type: 2, image_item: { media: { encrypt_query_param: "broken" } } }
        ]
      }
    )).resolves.toBe(true);

    expect(runtime.tomeet.sendEvent).not.toHaveBeenCalled();
    expect(runtime.tomeet.sendTextBatch).toHaveBeenCalledWith(expect.objectContaining({
      contents: ["看看这张"]
    }));
  });

  it("keeps polling and advances the cursor when a message cannot be handled", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.dependencies.downloadImage = vi.fn(async () => {
      throw new Error("微信图片格式不是 JPEG、PNG 或 WebP");
    });
    runtime.tomeet.sendEvent.mockRejectedValue(new Error("tomeet_api_error"));
    runtime.ilink.getUpdates.mockResolvedValueOnce({
      ret: 0,
      get_updates_buf: "cursor-after-broken-image",
      msgs: [{
        message_id: 91,
        message_type: 1,
        from_user_id: activeConnection.ownerIlinkUserId,
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "broken" } } }]
      }]
    });

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: new AbortController().signal,
      turnBatchWindowMs: 10
    });

    expect(runtime.store.markWechatConnectionError).not.toHaveBeenCalled();
    expect(runtime.store.updateWechatConnectionCursor).toHaveBeenCalledWith(
      activeConnection.id,
      "worker-1",
      "cursor-after-broken-image",
      expect.any(String)
    );
  });

  it("never folds a failed batch into the next one and apologizes once per turn", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.store.updateWechatConnectionCursor.mockResolvedValue(true);
    runtime.tomeet.sendTextBatch.mockRejectedValue(new Error("agent_job_failed"));
    let markApologyStarted!: () => void;
    const apologyStarted = new Promise<void>((resolve) => { markApologyStarted = resolve; });
    let releaseApology!: () => void;
    const apologyGate = new Promise<void>((resolve) => { releaseApology = resolve; });
    let bubble = 0;
    runtime.ilink.sendText.mockImplementation(async (_input) => {
      bubble += 1;
      if (bubble === 1) {
        markApologyStarted();
        await apologyGate;
      }
      return "client-1";
    });
    let poll = 0;
    const controller = new AbortController();
    runtime.ilink.getUpdates.mockImplementation(async () => {
      poll += 1;
      if (poll === 1) {
        return {
          ret: 0,
          get_updates_buf: "cursor-1",
          msgs: [{
            message_id: 101,
            message_type: 1,
            from_user_id: activeConnection.ownerIlinkUserId,
            item_list: [{ type: 1, text_item: { text: "你好" } }]
          }]
        };
      }
      if (poll === 2) {
        await apologyStarted;
        return {
          ret: 0,
          get_updates_buf: "cursor-2",
          msgs: [{
            message_id: 102,
            message_type: 1,
            from_user_id: activeConnection.ownerIlinkUserId,
            item_list: [{ type: 1, text_item: { text: "在吗" } }]
          }]
        };
      }
      releaseApology();
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      return { ret: 0, msgs: [], get_updates_buf: "cursor-3" };
    });

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: controller.signal,
      turnBatchWindowMs: 0
    });

    expect(runtime.tomeet.sendTextBatch.mock.calls.map(([input]) => input.messageIds)).toEqual([
      ["101"],
      ["102"]
    ]);
    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.text)).toEqual([
      channelTurnFailureNotice.zh,
      channelTurnFailureNotice.zh
    ]);
  });

  it("delivers a superseding batch even when the batch before it failed", async () => {
    const runtime = setup();
    const activeConnection = connection(runtime.cipher);
    runtime.store.updateWechatConnectionCursor.mockResolvedValue(true);
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let rejectFirst!: (error: Error) => void;
    runtime.tomeet.sendTextBatch
      .mockImplementationOnce(async () => {
        markFirstStarted();
        return new Promise<{ reply: string; stale: boolean }>((_, reject) => {
          rejectFirst = reject;
        });
      })
      .mockResolvedValue({ reply: "合并后的回复", stale: false });
    let registrations = 0;
    runtime.tomeet.setResponseGeneration.mockImplementation(async () => {
      registrations += 1;
      if (registrations === 2) {
        setTimeout(() => rejectFirst(new Error("agent_job_failed")), 20);
      }
    });
    let poll = 0;
    const controller = new AbortController();
    runtime.ilink.getUpdates.mockImplementation(async () => {
      poll += 1;
      if (poll === 1) {
        return {
          ret: 0,
          get_updates_buf: "cursor-1",
          msgs: [{
            message_id: 111,
            message_type: 1,
            from_user_id: activeConnection.ownerIlinkUserId,
            item_list: [{ type: 1, text_item: { text: "你好" } }]
          }]
        };
      }
      if (poll === 2) {
        await firstStarted;
        return {
          ret: 0,
          get_updates_buf: "cursor-2",
          msgs: [{
            message_id: 112,
            message_type: 1,
            from_user_id: activeConnection.ownerIlinkUserId,
            item_list: [{ type: 1, text_item: { text: "在吗" } }]
          }]
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      controller.abort();
      return { ret: 0, msgs: [], get_updates_buf: "cursor-3" };
    });

    await monitorWechatConnection({
      ...runtime.dependencies,
      connection: activeConnection,
      workerId: "worker-1",
      leaseSeconds: 300,
      signal: controller.signal,
      turnBatchWindowMs: 0
    });

    expect(runtime.tomeet.sendTextBatch.mock.calls.map(([input]) => input.messageIds)).toEqual([
      ["111"],
      ["111", "112"]
    ]);
    expect(runtime.ilink.sendText.mock.calls.map(([input]) => input.text)).toEqual([
      "合并后的回复"
    ]);
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
