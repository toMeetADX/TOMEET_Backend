import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  adventurexLanguageSchema,
  agentMessageInputSchema,
  agentProductEventSchema,
  confirmEventPlanInputSchema,
  createMatchRequestInputSchema,
  linkChannelIdentityInputSchema,
  multimodalInputSchema,
  postEventFeedbackSchema,
  resolveChannelIdentityInputSchema,
  saveMatchChoicesInputSchema,
  updateEventPlanInputSchema,
  uuidSchema
} from "@tomeet/contracts";
import type { DataStore } from "@tomeet/data";
import { StoreConflictError, StoreNotFoundError } from "@tomeet/data";
import {
  notifyEventPlanDraft,
  notifyEventPlanPublished,
  notifyRoomUpdate,
  scheduleAdventurexMatchRequest,
  type JobProcessor
} from "@tomeet/intelligence";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  AuthenticationError,
  AuthorizationError,
  type AccessTokenVerifier,
  type EmailAccessTokenMatcher
} from "./auth.js";
import { registerWechatRoutes, type WechatApiRuntime } from "./wechat-routes.js";

declare module "fastify" {
  interface FastifyRequest {
    authUserId?: string;
  }
}

export interface BuildAppOptions {
  store: DataStore;
  inlineProcessor?: JobProcessor;
  frontendOrigin?: string;
  internalApiToken?: string;
  autoProvisionChannelUsers?: boolean;
  wechat?: WechatApiRuntime;
  logger?: boolean;
  verifyAccessToken?: AccessTokenVerifier;
  trustProxy?: boolean;
  rateLimitMax?: number;
  wechatQrRateLimitMax?: number;
  wechatRapidQrAccessTokenMatches?: EmailAccessTokenMatcher;
  adventurexTestPoolAccessTokenMatches?: EmailAccessTokenMatcher;
  exposeInternalErrors?: boolean;
  readinessTimeoutMs?: number;
  adventurexMatchingV1?: boolean;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("readiness dependency timed out")),
        timeoutMs
      );
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function deterministicChannelUserId(provider: string, externalUserId: string): string {
  const bytes = createHash("sha256")
    .update(`${provider}:${externalUserId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

function decodeInternalImage(input: {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
}): Uint8Array {
  if (!/^[a-zA-Z0-9+/]+={0,2}$/u.test(input.dataBase64)) {
    throw new StoreConflictError("微信图片不是有效的 base64 数据");
  }
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new StoreConflictError("单张微信图片大小必须在 10MB 以内");
  }
  const detected = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? "image/jpeg"
    : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ? "image/png"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WEBP"
        ? "image/webp"
        : null;
  if (detected !== input.mimeType) throw new StoreConflictError("微信图片内容与 MIME 类型不一致");
  return Uint8Array.from(bytes);
}

export async function buildApp(options: BuildAppOptions) {
  const allowedOrigins = (options.frontendOrigin ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 21 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    trustProxy: options.trustProxy ?? false
  });

  app.decorateRequest("authUserId", undefined);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "x-request-id",
      "x-tomeet-internal-token",
      "x-wechat-session-token"
    ]
  });
  app.addHook("preValidation", async (request) => {
    if (!options.verifyAccessToken || request.method === "OPTIONS") return;
    const path = request.url.split("?", 1)[0];
    const isWechatSessionCreation = request.method === "POST" && (
      path === "/wechat/connect/sessions"
      || path === "/wechat/connect/sessions/demo"
    );
    if (
      path === "/health"
      || path === "/ready"
      || path?.startsWith("/internal/")
      || (path?.startsWith("/wechat/connect/sessions") && !isWechatSessionCreation)
      || (isWechatSessionCreation && !request.headers.authorization)
    ) {
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new AuthenticationError("缺少 Bearer access token");
    }
    const accessToken = authorization.slice("Bearer ".length).trim();
    if (!accessToken) throw new AuthenticationError("缺少 Bearer access token");
    request.authUserId = await options.verifyAccessToken(accessToken);
  });

  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip
  });

  function assertCurrentUser(request: FastifyRequest, userId: string): void {
    if (request.authUserId && request.authUserId !== userId) {
      throw new AuthorizationError("不能访问或操作其他用户的数据");
    }
  }

  function assertRoomMember(request: FastifyRequest, memberIds: string[]): void {
    if (request.authUserId && !memberIds.includes(request.authUserId)) {
      throw new StoreNotFoundError("房间不存在");
    }
  }

  async function runInline(jobId: string) {
    if (!options.inlineProcessor) return options.store.getJob(jobId);
    const job = await options.store.getJob(jobId);
    if (!job || job.status === "completed" || job.status === "failed") return job;
    try {
      const result = await options.inlineProcessor.process(job);
      await options.store.completeJob(job.id, result);
      for (let index = 0; index < 10; index += 1) {
        const queued = await options.store.claimJob("inline-demo");
        if (!queued) break;
        try {
          const queuedResult = await options.inlineProcessor.process(queued);
          await options.store.completeJob(queued.id, queuedResult);
        } catch (error) {
          await options.store.failJob(queued.id, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      await options.store.failJob(job.id, error instanceof Error ? error.message : String(error));
    }
    return options.store.getJob(jobId);
  }

  async function scheduleAdventurexRequest(matchRequest: import("@tomeet/contracts").MatchRequest) {
    return scheduleAdventurexMatchRequest(options.store, matchRequest);
  }

  async function enqueueRoomContinuation(roomId: string, memberCount: number, reason: string): Promise<void> {
    const room = await options.store.getRoom(roomId);
    if (
      !room
      || room.status === "completed"
      || room.matchingStatus !== "active"
      || room.members.length >= room.capacity
      || !room.eventPlans.published
    ) return;
    const job = await options.store.enqueueJob({
      type: "matchmaking",
      payload: { roomId },
      idempotencyKey: `match:room:${roomId}:${memberCount}:${reason}`,
      partitionKey: `room:${roomId}`
    });
    await runInline(job.id);
  }

  async function enqueueRequeuedRequests(requestIds: string[], reason: string): Promise<void> {
    await Promise.all(requestIds.map(async (requestId) => {
      const matchRequest = await options.store.getMatchRequest(requestId);
      if (!matchRequest || matchRequest.status !== "matching") return;
      const job = await options.store.enqueueJob({
        type: "matchmaking",
        payload: { requestId },
        idempotencyKey: `match:${requestId}:${reason}`,
        partitionKey: `user:${matchRequest.userId}`
      });
      await runInline(job.id);
    }));
  }

  app.get("/health", { config: { rateLimit: false } }, async () => ({
    status: "ok",
    service: "tomeet-api",
    time: new Date().toISOString()
  }));

  app.get("/ready", { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await withTimeout(options.store.ping(), options.readinessTimeoutMs ?? 3000);
      return { status: "ready", service: "tomeet-api" };
    } catch (error) {
      if (options.exposeInternalErrors) {
        return reply.code(503).send({
          status: "not_ready",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return reply.code(503).send({ status: "not_ready", message: "依赖服务暂不可用" });
    }
  });

  function internalTokenMatches(candidate: unknown): boolean {
    if (!options.internalApiToken || typeof candidate !== "string") return false;
    const expectedHash = createHash("sha256").update(options.internalApiToken).digest();
    const candidateHash = createHash("sha256").update(candidate).digest();
    return timingSafeEqual(expectedHash, candidateHash);
  }

  app.post(
    "/internal/users/:userId/adventurex-onboarding/start",
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
        return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
      }
      const { userId } = z.object({ userId: uuidSchema }).parse(request.params);
      const { language } = z.object({
        language: adventurexLanguageSchema.default("zh")
      }).parse(request.body ?? {});
      const state = await options.store.ensureAdventurexOnboardingState(userId);
      if (state.welcomeDeliveredAt) return { message: null };
      const message = await options.store.startAdventurexOnboarding(userId, language);
      return { message };
    }
  );

  registerWechatRoutes(app, {
    runtime: options.wechat,
    internalApiEnabled: Boolean(options.internalApiToken),
    internalTokenMatches,
    publicSessionRateLimitMax: options.wechatQrRateLimitMax,
    rapidQrAccessTokenMatches: options.wechatRapidQrAccessTokenMatches,
    isNewWechatIdentity: async (externalUserId) => (
      (await options.store.resolveChannelIdentity("wechat", externalUserId)) === null
    ),
    onActivated: async ({ userId, deliverText }) => {
      const onboardingState = await options.store.ensureAdventurexOnboardingState(userId);
      if (onboardingState.welcomeDeliveredAt) return;
      const message = await options.store.startAdventurexOnboarding(userId, "zh");
      if (!message || !deliverText) return;
      const bubbles = message.content.split(/\n\s*\n+/u).filter(Boolean);
      for (const [index, text] of bubbles.entries()) {
        await deliverText({ text, runId: `activation-welcome-${userId}-${index + 1}` });
      }
      await options.store.markAdventurexWelcomeDelivered(userId);
    }
  });

  app.post(
    "/internal/users/:userId/adventurex-onboarding/welcome-delivered",
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
        return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
      }
      const { userId } = z.object({ userId: uuidSchema }).parse(request.params);
      return { state: await options.store.markAdventurexWelcomeDelivered(userId) };
    }
  );

  async function requireAdventurexTestPoolOwner(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    if (!options.adventurexTestPoolAccessTokenMatches) {
      reply.code(503).send({
        error: "adventurex_test_pool_disabled",
        message: "虚拟测试用户池未启用"
      });
      return null;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "unauthorized", message: "缺少 Bearer access token" });
      return null;
    }
    const accessToken = authorization.slice("Bearer ".length).trim();
    if (!accessToken || !(await options.adventurexTestPoolAccessTokenMatches(accessToken))) {
      reply.code(403).send({ error: "forbidden", message: "当前账号不能使用虚拟测试用户池" });
      return null;
    }
    if (!request.authUserId) {
      reply.code(401).send({ error: "unauthorized", message: "无法识别当前账号" });
      return null;
    }
    return request.authUserId;
  }

  app.get("/adventurex/test-pool", async (request, reply) => {
    const ownerUserId = await requireAdventurexTestPoolOwner(request, reply);
    if (!ownerUserId) return reply;
    return { testPool: await options.store.getAdventurexTestPoolStatus(ownerUserId) };
  });

  app.post("/adventurex/test-pool", async (request, reply) => {
    const ownerUserId = await requireAdventurexTestPoolOwner(request, reply);
    if (!ownerUserId) return reply;
    const input = z.object({
      enabled: z.boolean(),
      desiredUserCount: z.number().int().min(3).max(12).default(5)
    }).parse(request.body);
    return {
      testPool: await options.store.configureAdventurexTestPool(ownerUserId, input)
    };
  });

  app.post("/internal/channel-identities/resolve", { config: { rateLimit: false } }, async (request, reply) => {
    if (!options.internalApiToken) {
      return reply.code(503).send({
        error: "internal_api_disabled",
        message: "内部渠道 API 未配置"
      });
    }
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    const input = resolveChannelIdentityInputSchema.parse(request.body);
    let identity = await options.store.resolveChannelIdentity(input.provider, input.externalUserId);
    if (!identity && options.autoProvisionChannelUsers) {
      const userId = deterministicChannelUserId(input.provider, input.externalUserId);
      await options.store.ensureUser(userId, "微信测试用户");
      identity = await options.store.linkChannelIdentity({
        ...input,
        userId,
        displayName: "微信测试用户"
      });
    }
    if (!identity) {
      return reply.code(404).send({
        error: "channel_identity_unlinked",
        message: "该渠道身份尚未绑定 TOMEET 账号"
      });
    }
    return { identity };
  });

  app.post("/internal/channel-identities", { config: { rateLimit: false } }, async (request, reply) => {
    if (!options.internalApiToken) {
      return reply.code(503).send({
        error: "internal_api_disabled",
        message: "内部渠道 API 未配置"
      });
    }
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    const input = linkChannelIdentityInputSchema.parse(request.body);
    const identity = await options.store.linkChannelIdentity(input);
    return reply.code(201).send({ identity });
  });

  async function submitAgentMessage(
    request: FastifyRequest,
    reply: FastifyReply,
    sourceChannel: "web" | "wechat"
  ) {
    const input = agentMessageInputSchema.parse(request.body);
    const generation = sourceChannel === "wechat"
      ? z.object({
          connectionId: uuidSchema.optional(),
          generationToken: z.string().min(8).max(128).optional(),
          messages: z.array(z.object({
            messageId: z.string().min(1).max(255),
            content: z.string().trim().min(1).max(20_000),
            idempotencyKey: z.string().min(8).max(128)
          })).min(1).max(20).optional()
        }).refine(
          (value) => Boolean(value.connectionId) === Boolean(value.generationToken),
          "connectionId 与 generationToken 必须同时提供"
        ).parse(request.body)
      : {};
    assertCurrentUser(request, input.userId);
    await options.store.ensureUser(input.userId, input.displayName);
    const rawMessages = "messages" in generation ? generation.messages : undefined;
    const savedMessages = rawMessages
      ? await Promise.all(rawMessages.map((item) => options.store.appendMessage({
          userId: input.userId,
          role: "user",
          content: item.content,
          idempotencyKey: item.idempotencyKey,
          sourceChannel
        })))
      : [await options.store.appendMessage({
          userId: input.userId,
          role: "user",
          content: input.content,
          idempotencyKey: input.idempotencyKey,
          sourceChannel
        })];
    const userMessage = savedMessages.at(-1)!;
    const connectionId = "connectionId" in generation ? generation.connectionId : undefined;
    const generationToken = "generationToken" in generation ? generation.generationToken : undefined;
    const job = await options.store.enqueueJob({
      type: "agent_reply",
      payload: {
        userId: input.userId,
        content: input.content,
        userMessageId: userMessage.id,
        sourceChannel,
        connectionId,
        generationToken
      },
      idempotencyKey: generationToken
        ? `agent-generation:${connectionId}:${generationToken}`
        : `agent:${userMessage.id}`,
      partitionKey: `user:${input.userId}`
    });
    const currentJob = await runInline(job.id);
    return reply.code(currentJob?.status === "completed" ? 200 : 202).send({ userMessage, job: currentJob });
  }

  app.post("/agent/messages", async (request, reply) =>
    submitAgentMessage(request, reply, "web")
  );

  app.post("/internal/agent/messages", { config: { rateLimit: false } }, async (request, reply) => {
    if (!options.internalApiToken) {
      return reply.code(503).send({
        error: "internal_api_disabled",
        message: "内部渠道 API 未配置"
      });
    }
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    return submitAgentMessage(request, reply, "wechat");
  });

  app.post("/internal/agent/response-generations", { config: { rateLimit: false } }, async (request, reply) => {
    if (!options.internalApiToken) {
      return reply.code(503).send({ error: "internal_api_disabled", message: "内部渠道 API 未配置" });
    }
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    const input = z.object({
      connectionId: uuidSchema,
      generationToken: z.string().min(8).max(128)
    }).parse(request.body);
    await options.store.setWechatResponseGeneration(input.connectionId, input.generationToken);
    return reply.code(204).send();
  });

  app.post("/internal/agent/events", { config: { rateLimit: false } }, async (request, reply) => {
    if (!options.internalApiToken) {
      return reply.code(503).send({ error: "internal_api_disabled", message: "内部渠道 API 未配置" });
    }
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    const input = z.object({
      userId: uuidSchema,
      event: agentProductEventSchema,
      idempotencyKey: z.string().min(8).max(128)
    }).parse(request.body);
    await options.store.ensureUser(input.userId);
    const job = await options.store.enqueueJob({
      type: "agent_event_reply",
      payload: {
        userId: input.userId,
        event: input.event,
        messageIdempotencyKey: input.idempotencyKey,
        sourceChannel: "wechat"
      },
      idempotencyKey: `agent-event:${input.idempotencyKey}`,
      partitionKey: `user:${input.userId}`
    });
    const currentJob = await runInline(job.id);
    return reply.code(currentJob?.status === "completed" ? 200 : 202).send({ job: currentJob });
  });

  async function listAgentMessages(request: FastifyRequest) {
    const { userId } = z.object({ userId: uuidSchema }).parse(request.params);
    assertCurrentUser(request, userId);
    return { messages: await options.store.listRecentMessages(userId, 100) };
  }

  app.get("/agent/messages/:userId", listAgentMessages);

  app.get("/internal/agent/messages/:userId", { config: { rateLimit: false } }, async (request, reply) => {
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    return listAgentMessages(request);
  });

  app.post("/agent/multimodal-inputs", async (request, reply) => {
    const input = multimodalInputSchema.parse(request.body);
    assertCurrentUser(request, input.userId);
    if (!input.storagePath.startsWith(`${input.userId}/`)) {
      throw new StoreConflictError("多模态文件不属于当前用户");
    }
    const inputId = await options.store.saveMultimodalInput(input);
    await options.store.appendMessage({
      userId: input.userId,
      role: "user",
      content: input.kind === "image"
        ? `[发送了一张图片]${input.hint ? ` ${input.hint}` : ""}`
        : `[发送了一段录音]${input.hint ? ` ${input.hint}` : ""}`,
      idempotencyKey: `multimodal-user:${inputId}`,
      sourceChannel: "web"
    });
    const job = await options.store.enqueueJob({
      type: "multimodal_understanding",
      payload: { ...input, inputId, sourceChannel: "web" },
      idempotencyKey: `multimodal:${inputId}`,
      partitionKey: `user:${input.userId}`
    });
    const currentJob = await runInline(job.id);
    return reply.code(currentJob?.status === "completed" ? 200 : 202).send({ inputId, job: currentJob });
  });

  app.post("/internal/agent/multimodal-inputs", { config: { rateLimit: false } }, async (request, reply) => {
    if (!options.internalApiToken) {
      return reply.code(503).send({ error: "internal_api_disabled", message: "内部渠道 API 未配置" });
    }
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    const input = z.object({
      userId: uuidSchema,
      connectionId: uuidSchema.optional(),
      generationToken: z.string().min(8).max(128).optional(),
      images: z.array(z.object({
        messageId: z.string().min(1).max(255).optional(),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        dataBase64: z.string().min(4).max(14 * 1024 * 1024)
      })).min(1).max(9),
      turns: z.array(z.object({
        messageId: z.string().min(1).max(255),
        content: z.string().trim().min(1).max(2_000).optional(),
        imageCount: z.number().int().min(0).max(9),
        idempotencyKey: z.string().min(8).max(128)
      })).min(1).max(20).optional(),
      messageIds: z.array(z.string().min(1).max(255)).min(1).max(20).optional(),
      hint: z.string().trim().min(1).max(2_000).optional(),
      idempotencyKey: z.string().min(8).max(128)
    }).refine(
      (value) => Boolean(value.connectionId) === Boolean(value.generationToken),
      "connectionId 与 generationToken 必须同时提供"
    ).parse(request.body);
    const decoded = input.images.map((image) => ({
      mimeType: image.mimeType,
      bytes: decodeInternalImage(image)
    }));
    const totalBytes = decoded.reduce((sum, image) => sum + image.bytes.length, 0);
    if (totalBytes > 30 * 1024 * 1024) {
      throw new StoreConflictError("单批微信图片总大小必须在 30MB 以内");
    }
    await options.store.ensureUser(input.userId, "微信用户");
    const imageMessageIds = input.images.map((image, index) =>
      image.messageId ?? input.messageIds?.[index] ?? `batch-${index + 1}`
    );
    const turns = input.turns ?? [...new Set(input.messageIds ?? imageMessageIds)].map((messageId, index) => ({
      messageId,
      ...(index === 0 && input.hint ? { content: input.hint } : {}),
      imageCount: imageMessageIds.filter((id) => id === messageId).length,
      idempotencyKey: `multimodal-turn:${input.idempotencyKey}:${messageId}`
    }));
    const turnByMessageId = new Map(turns.map((turn) => [turn.messageId, turn]));
    const records = await Promise.all(decoded.map(async (image, index) => {
      const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]!;
      const storagePath = `${input.userId}/${randomUUID()}.${extension}`;
      await options.store.uploadFile(storagePath, image.mimeType, image.bytes);
      const inputId = await options.store.saveMultimodalInput({
        userId: input.userId,
        kind: "image",
        storagePath,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.length,
        hint: turnByMessageId.get(imageMessageIds[index]!)?.content
      });
      return { inputId, storagePath, mimeType: image.mimeType };
    }));
    const savedMessages = await Promise.all(turns.map((turn) => {
      const imagePrefix = turn.imageCount === 0
        ? ""
        : turn.imageCount === 1 ? "[发送了一张图片]" : `[一次发送了 ${turn.imageCount} 张图片]`;
      return options.store.appendMessage({
        userId: input.userId,
        role: "user",
        content: [imagePrefix, turn.content].filter(Boolean).join("\n"),
        idempotencyKey: turn.idempotencyKey,
        sourceChannel: "wechat"
      });
    }));
    const userMessage = savedMessages.at(-1)!;
    const hint = turns.flatMap((turn) => turn.content ? [turn.content] : []).join("\n") || undefined;
    const job = await options.store.enqueueJob({
      type: "multimodal_understanding",
      payload: {
        userId: input.userId,
        inputIds: records.map((record) => record.inputId),
        storagePaths: records.map((record) => record.storagePath),
        mimeTypes: records.map((record) => record.mimeType),
        kind: "image",
        hint,
        userMessageId: userMessage.id,
        sourceChannel: "wechat",
        connectionId: input.connectionId,
        generationToken: input.generationToken
      },
      idempotencyKey: `multimodal:${input.idempotencyKey}`,
      partitionKey: `user:${input.userId}`
    });
    const currentJob = await runInline(job.id);
    return reply.code(currentJob?.status === "completed" ? 200 : 202).send({
      inputIds: records.map((record) => record.inputId),
      job: currentJob
    });
  });

  app.post("/uploads/sign", async (request) => {
    const input = z.object({
      userId: uuidSchema,
      fileName: z.string().min(1).max(255),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "audio/mpeg", "audio/mp4", "audio/webm"]),
      sizeBytes: z.number().int().positive().max(20 * 1024 * 1024)
    }).parse(request.body);
    assertCurrentUser(request, input.userId);
    await options.store.ensureUser(input.userId);
    const extension = input.fileName.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
    const storagePath = `${input.userId}/${randomUUID()}.${extension}`;
    return options.store.createSignedUpload(storagePath);
  });

  app.post("/uploads", async (request) => {
    const input = z.object({
      userId: uuidSchema,
      fileName: z.string().min(1).max(255),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      dataUrl: z.string().max(15 * 1024 * 1024)
    }).parse(request.body);
    assertCurrentUser(request, input.userId);
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(input.dataUrl);
    const encoded = match?.[2];
    if (!match || match[1] !== input.mimeType || !encoded) throw new StoreConflictError("图片数据与 MIME 不一致");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
      throw new StoreConflictError("图片大小必须在 10MB 以内");
    }
    await options.store.ensureUser(input.userId);
    const extension = input.mimeType === "image/jpeg" ? "jpg" : input.mimeType.split("/")[1];
    const storagePath = `${input.userId}/${randomUUID()}.${extension}`;
    await options.store.uploadFile(storagePath, input.mimeType, bytes);
    return { storagePath, mimeType: input.mimeType, sizeBytes: bytes.length };
  });

  app.post("/users/:userId/adventurex-onboarding/start", async (request) => {
    const { userId } = z.object({ userId: uuidSchema }).parse(request.params);
    const { language } = z.object({
      language: adventurexLanguageSchema.default("zh")
    }).parse(request.body ?? {});
    assertCurrentUser(request, userId);
    const message = await options.store.startAdventurexOnboarding(userId, language);
    const state = await options.store.ensureAdventurexOnboardingState(userId);
    return { state, message, messages: message ? [message] : [] };
  });

  app.get("/users/:userId/model", async (request) => {
    const { userId } = z.object({ userId: uuidSchema }).parse(request.params);
    assertCurrentUser(request, userId);
    return { userModel: await options.store.getUserModel(userId) };
  });

  app.get("/offline-games", async () => ({ games: await options.store.listOfflineGames() }));

  app.post("/match-requests", async (request, reply) => {
    const input = createMatchRequestInputSchema.parse(request.body);
    assertCurrentUser(request, input.userId);
    const [model, latestRoom] = await Promise.all([
      options.store.getUserModel(input.userId),
      options.store.getLatestRoomForUser(input.userId)
    ]);
    if (latestRoom && latestRoom.status !== "completed") {
      throw new StoreConflictError("你还有一个未结束的匹配房间");
    }
    const intent = input.intent ?? model.currentIntent;
    if (Object.keys(intent).length === 0) throw new StoreConflictError("请先在对话中明确本次社交意图");
    if (!input.intent && intent.socialIntentConfirmed !== true) {
      throw new StoreConflictError("请先在对话中明确本次社交意图");
    }
    const matchRequest = await options.store.createMatchRequest(input.userId, intent);
    const job = options.adventurexMatchingV1
      ? (await scheduleAdventurexRequest(matchRequest)).job
      : await options.store.enqueueJob({
          type: "matchmaking",
          payload: { requestId: matchRequest.requestId },
          idempotencyKey: `match:${matchRequest.requestId}`,
          partitionKey: `user:${input.userId}`
        });
    if (options.adventurexMatchingV1) {
      await options.store.updateAdventurexOnboardingState(input.userId, { stage: "matching" });
    }
    const currentJob = await runInline(job.id);
    const latestRequest = await options.store.getMatchRequest(matchRequest.requestId);
    const invite = await options.store.getLatestMatchInviteForUser(input.userId);
    return reply.code(latestRequest?.status === "matched" ? 201 : 202).send({
      matchRequest: latestRequest,
      invite,
      job: currentJob
    });
  });

  app.get("/match-requests/:id", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const matchRequest = await options.store.getMatchRequest(id);
    if (!matchRequest) throw new StoreNotFoundError("匹配请求不存在");
    if (request.authUserId && matchRequest.userId !== request.authUserId) {
      throw new StoreNotFoundError("匹配请求不存在");
    }
    return { matchRequest };
  });

  app.get("/match-requests/:id/options", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const matchRequest = await options.store.getMatchRequest(id);
    if (!matchRequest || (request.authUserId && matchRequest.userId !== request.authUserId)) {
      throw new StoreNotFoundError("匹配请求不存在");
    }
    const context = await options.store.listCurrentMatchOptions(matchRequest.userId);
    if (!context || context.requestId !== id) throw new StoreNotFoundError("当前候选不存在");
    return {
      requestId: context.requestId,
      roundId: context.roundId,
      expiresAt: context.expiresAt,
      options: context.options.map((option) => ({
        optionNumber: option.optionNumber,
        activity: { id: option.offlineGameId, name: option.activityName },
        previewText: option.previewText
      }))
    };
  });

  app.post("/match-requests/:id/choices", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const input = saveMatchChoicesInputSchema.parse(request.body);
    const matchRequest = await options.store.getMatchRequest(id);
    if (!matchRequest || (request.authUserId && matchRequest.userId !== request.authUserId)) {
      throw new StoreNotFoundError("匹配请求不存在");
    }
    const choices = await options.store.saveMatchChoices(id, input);
    const preferredOpenRoom = choices.find((choice) => choice.preferenceRank === 1 && choice.sourceType === "open_room");
    if (!preferredOpenRoom) {
      const notifyJob = choices.some((choice) => choice.draftId)
        ? await options.store.enqueueJob({
            type: "room_change_notify",
            payload: { roundId: matchRequest.activeRoundId },
            idempotencyKey: `draft-change-notify:${matchRequest.requestId}:${matchRequest.updatedAt}`,
            partitionKey: `match-round:${matchRequest.activeRoundId}`
          })
        : null;
      return { choices, status: "waiting_for_settlement", jobId: notifyJob?.id ?? null };
    }
    const context = await options.store.listCurrentMatchOptions(matchRequest.userId);
    const offer = context?.options.find((option) => option.roomId === preferredOpenRoom.roomId);
    if (!offer) throw new StoreConflictError("开放局候选已经变化");
    const room = await options.store.joinOpenRoom(id, offer.offerId, offer.sourceVersion);
    await options.store.enqueueJob({
      type: "room_change_notify",
      payload: { roomId: room.roomId },
      idempotencyKey: `room-change-notify:${room.roomId}:${room.version}`,
      partitionKey: `room:${room.roomId}`
    });
    return { choices, room, status: "joined" };
  });

  app.post("/match-requests/:id/options/refresh", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const matchRequest = await options.store.getMatchRequest(id);
    if (!matchRequest || (request.authUserId && matchRequest.userId !== request.authUserId)) {
      throw new StoreNotFoundError("匹配请求不存在");
    }
    await options.store.expireMatchOptions(id);
    const current = await options.store.getMatchRequest(id);
    if (!current) throw new StoreNotFoundError("匹配请求不存在");
    const scheduled = await scheduleAdventurexRequest(current);
    return { matchRequest: current, round: scheduled.round };
  });

  app.post("/match-requests/:id/cancel", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const matchRequest = await options.store.getMatchRequest(id);
    if (!matchRequest || (request.authUserId && matchRequest.userId !== request.authUserId)) {
      throw new StoreNotFoundError("匹配请求不存在");
    }
    return { matchRequest: await options.store.cancelMatchRequest(id), canRematch: true };
  });

  app.post("/match-requests/:id/rematch", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const previous = await options.store.getMatchRequest(id);
    if (!previous || (request.authUserId && previous.userId !== request.authUserId)) {
      throw new StoreNotFoundError("匹配请求不存在");
    }
    const matchRequest = await options.store.restartMatch(id);
    const scheduled = await scheduleAdventurexRequest(matchRequest);
    return { matchRequest, round: scheduled.round };
  });

  app.post("/match-requests/:id/open-room/:roomId/join", async (request) => {
    const params = z.object({ id: uuidSchema, roomId: uuidSchema }).parse(request.params);
    const body = z.object({ offerId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).parse(request.body);
    const matchRequest = await options.store.getMatchRequest(params.id);
    if (!matchRequest || (request.authUserId && matchRequest.userId !== request.authUserId)) {
      throw new StoreNotFoundError("匹配请求不存在");
    }
    const room = await options.store.joinOpenRoom(params.id, body.offerId, body.sourceVersion);
    if (room.roomId !== params.roomId) throw new StoreConflictError("候选房间与路径不一致");
    await options.store.enqueueJob({
      type: "room_change_notify",
      payload: { roomId: room.roomId },
      idempotencyKey: `room-change-notify:${room.roomId}:${room.version}`,
      partitionKey: `room:${room.roomId}`
    });
    return { room };
  });

  app.get("/match-invites/:id", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const invite = await options.store.getMatchInvite(id);
    if (!invite) throw new StoreNotFoundError("匹配邀请不存在");
    if (request.authUserId && !invite.participants.some(
      (participant) => participant.userId === request.authUserId
    )) {
      throw new StoreNotFoundError("匹配邀请不存在");
    }
    return { invite };
  });

  app.post("/match-invites/:id/accept", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const { userId } = z.object({ userId: uuidSchema }).parse(request.body);
    assertCurrentUser(request, userId);
    const resolution = await options.store.acceptMatchInvite(id, userId);
    if (resolution.room) {
      await notifyRoomUpdate(options.store, resolution.room, resolution.invite);
      await enqueueRoomContinuation(
        resolution.room.roomId,
        resolution.room.members.length,
        `api-accepted:${id}`
      );
    }
    return resolution;
  });

  app.post("/match-invites/:id/decline", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const { userId } = z.object({ userId: uuidSchema }).parse(request.body);
    assertCurrentUser(request, userId);
    const resolution = await options.store.declineMatchInvite(id, userId);
    await enqueueRequeuedRequests(resolution.requeuedRequestIds, `api-declined:${id}`);
    if (resolution.room) {
      await enqueueRoomContinuation(
        resolution.room.roomId,
        resolution.room.members.length,
        `api-declined:${id}`
      );
    }
    return resolution;
  });

  async function getJob(request: FastifyRequest) {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const job = await options.store.getJob(id);
    if (!job) throw new StoreNotFoundError("任务不存在");
    if (request.authUserId && job.partitionKey !== `user:${request.authUserId}`) {
      throw new StoreNotFoundError("任务不存在");
    }
    return { job };
  }

  app.get("/jobs/:id", getJob);

  app.get("/internal/jobs/:id", { config: { rateLimit: false } }, async (request, reply) => {
    if (!internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
      return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
    }
    return getJob(request);
  });

  app.get("/rooms/:id", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const room = await options.store.getRoom(id);
    if (!room) throw new StoreNotFoundError("房间不存在");
    assertRoomMember(request, room.members.map((member) => member.userId));
    return { room };
  });

  app.patch("/rooms/:id/event-plan", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const input = updateEventPlanInputSchema.parse(request.body);
    assertCurrentUser(request, input.userId);
    const mutation = await options.store.updateEventPlan(
      id,
      input.userId,
      input.expectedVersion,
      input.patch
    );
    const actor = mutation.room.members.find((member) => member.userId === input.userId);
    await notifyEventPlanDraft(options.store, mutation.room, {
      reason: "updated",
      actorName: actor?.displayName
    });
    return mutation;
  });

  app.post("/rooms/:id/event-plan/confirm", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const input = confirmEventPlanInputSchema.parse(request.body);
    assertCurrentUser(request, input.userId);
    const mutation = await options.store.confirmEventPlan(id, input.userId, input.version);
    if (mutation.published) {
      await notifyEventPlanPublished(options.store, mutation.room);
      await enqueueRoomContinuation(
        mutation.room.roomId,
        mutation.room.members.length,
        `api-event-plan-published:${mutation.eventPlan.version}`
      );
    } else {
      const actor = mutation.room.members.find((member) => member.userId === input.userId);
      await notifyEventPlanDraft(options.store, mutation.room, {
        reason: "confirmed",
        actorName: actor?.displayName
      });
    }
    return mutation;
  });

  app.post("/rooms/:id/confirm", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const { userId } = z.object({ userId: uuidSchema }).parse(request.body);
    assertCurrentUser(request, userId);
    return { room: await options.store.confirmRoom(id, userId) };
  });

  app.post("/rooms/:id/leave", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const { userId, reason } = z.object({
      userId: uuidSchema,
      reason: z.string().trim().min(1).max(500).optional()
    }).parse(request.body);
    assertCurrentUser(request, userId);
    const room = await options.store.leaveRoom(id, userId, reason);
    await options.store.enqueueJob({
      type: "room_change_notify",
      payload: { roomId: room.roomId },
      idempotencyKey: `room-change-notify:${room.roomId}:${room.version}`,
      partitionKey: `room:${room.roomId}`
    });
    const matchRequest = await options.store.getLatestMatchRequestForUser(userId);
    return {
      room,
      matchRequest,
      canRematch: false,
      interestState: matchRequest?.status === "matching" ? matchRequest.phase : "ended"
    };
  });

  app.post("/rooms/:id/stop-match", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const { userId } = z.object({ userId: uuidSchema }).parse(request.body);
    assertCurrentUser(request, userId);
    const stopped = await options.store.stopRoomMatching(id, userId);
    await enqueueRequeuedRequests(stopped.requeuedRequestIds, `api-room-stopped:${id}`);
    return stopped;
  });

  app.post("/rooms/:id/complete", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const room = await options.store.getRoom(id);
    if (!room) throw new StoreNotFoundError("房间不存在");
    assertRoomMember(request, room.members.map((member) => member.userId));
    return { room: await options.store.completeRoom(id) };
  });

  app.post("/rooms/:id/feedback", async (request, reply) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const body = z.object({ userId: uuidSchema }).passthrough().parse(request.body);
    const feedback = postEventFeedbackSchema.parse({ ...body, roomId: id });
    assertCurrentUser(request, feedback.userId);
    const feedbackId = await options.store.saveFeedback(feedback);
    const job = await options.store.enqueueJob({
      type: "feedback_update",
      payload: { feedback, feedbackId },
      idempotencyKey: `feedback:${feedbackId}`,
      partitionKey: `user:${feedback.userId}`
    });
    const currentJob = await runInline(job.id);
    return reply.code(currentJob?.status === "completed" ? 200 : 202).send({ feedbackId, job: currentJob });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "NOT_FOUND", message: "接口不存在", requestId: request.id });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "请求参数不正确",
        details: error.flatten(),
        requestId: request.id
      });
    }
    if (error instanceof AuthenticationError) {
      return reply.code(401).send({
        error: "UNAUTHENTICATED",
        message: error.message,
        requestId: request.id
      });
    }
    if (error instanceof AuthorizationError) {
      return reply.code(403).send({
        error: "FORBIDDEN",
        message: error.message,
        requestId: request.id
      });
    }
    if (error instanceof StoreNotFoundError) {
      return reply.code(404).send({ error: "NOT_FOUND", message: error.message, requestId: request.id });
    }
    if (error instanceof StoreConflictError) {
      return reply.code(409).send({ error: "CONFLICT", message: error.message, requestId: request.id });
    }
    const httpError = error as { statusCode?: number; message?: string };
    if (httpError.statusCode === 413) {
      return reply.code(413).send({
        error: "PAYLOAD_TOO_LARGE",
        message: "请求体过大",
        requestId: request.id
      });
    }
    if (httpError.statusCode === 429) {
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "请求过于频繁，请稍后重试",
        requestId: request.id
      });
    }
    if (httpError.statusCode && httpError.statusCode >= 400 && httpError.statusCode < 500) {
      return reply.code(httpError.statusCode).send({
        error: "HTTP_ERROR",
        message: httpError.message ?? "请求无法处理",
        requestId: request.id
      });
    }
    request.log.error(error);
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: options.exposeInternalErrors && error instanceof Error
        ? error.message
        : "服务暂时不可用",
      requestId: request.id
    });
  });

  return app;
}
