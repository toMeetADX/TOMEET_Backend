import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  agentMessageInputSchema,
  createMatchRequestInputSchema,
  multimodalInputSchema,
  postEventFeedbackSchema,
  uuidSchema
} from "@tomeet/contracts";
import type { DataStore } from "@tomeet/data";
import { StoreConflictError, StoreNotFoundError } from "@tomeet/data";
import type { JobProcessor } from "@tomeet/intelligence";
import Fastify from "fastify";
import { z, ZodError } from "zod";

export interface BuildAppOptions {
  store: DataStore;
  inlineProcessor?: JobProcessor;
  frontendOrigin?: string;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions) {
  const allowedOrigins = (options.frontendOrigin ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 21 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID()
  });

  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"]
  });
  app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.headers["x-user-id"]?.toString() ?? request.ip
  });

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

  app.get("/health", async () => ({ status: "ok", service: "tomeet-api", time: new Date().toISOString() }));

  app.get("/ready", async (_request, reply) => {
    try {
      await options.store.ping();
      return { status: "ready" };
    } catch (error) {
      return reply.code(503).send({ status: "not_ready", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/agent/messages", async (request, reply) => {
    const input = agentMessageInputSchema.parse(request.body);
    await options.store.ensureUser(input.userId, input.displayName);
    const userMessage = await options.store.appendMessage({
      userId: input.userId,
      role: "user",
      content: input.content,
      idempotencyKey: input.idempotencyKey
    });
    const job = await options.store.enqueueJob({
      type: "agent_reply",
      payload: { userId: input.userId, content: input.content, userMessageId: userMessage.id },
      idempotencyKey: `agent:${userMessage.id}`,
      partitionKey: `user:${input.userId}`
    });
    const currentJob = await runInline(job.id);
    return reply.code(currentJob?.status === "completed" ? 200 : 202).send({ userMessage, job: currentJob });
  });

  app.get("/agent/messages/:userId", async (request) => {
    const { userId } = z.object({ userId: uuidSchema }).parse(request.params);
    return { messages: await options.store.listRecentMessages(userId, 100) };
  });

  app.post("/agent/multimodal-inputs", async (request, reply) => {
    const input = multimodalInputSchema.parse(request.body);
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
      idempotencyKey: `multimodal-user:${inputId}`
    });
    const job = await options.store.enqueueJob({
      type: "multimodal_understanding",
      payload: { ...input, inputId },
      idempotencyKey: `multimodal:${inputId}`,
      partitionKey: `user:${input.userId}`
    });
    const currentJob = await runInline(job.id);
    return reply.code(currentJob?.status === "completed" ? 200 : 202).send({ inputId, job: currentJob });
  });

  app.post("/uploads/sign", async (request) => {
    const input = z.object({
      userId: uuidSchema,
      fileName: z.string().min(1).max(255),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "audio/mpeg", "audio/mp4", "audio/webm"]),
      sizeBytes: z.number().int().positive().max(20 * 1024 * 1024)
    }).parse(request.body);
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

  app.get("/users/:userId/model", async (request) => {
    const { userId } = z.object({ userId: uuidSchema }).parse(request.params);
    return { userModel: await options.store.getUserModel(userId) };
  });

  app.get("/offline-games", async () => ({ games: await options.store.listOfflineGames() }));

  app.post("/match-requests", async (request, reply) => {
    const input = createMatchRequestInputSchema.parse(request.body);
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
    const job = await options.store.enqueueJob({
      type: "matchmaking",
      payload: { requestId: matchRequest.requestId },
      idempotencyKey: `match:${matchRequest.requestId}`,
      partitionKey: `user:${input.userId}`
    });
    const currentJob = await runInline(job.id);
    const latestRequest = await options.store.getMatchRequest(matchRequest.requestId);
    return reply.code(latestRequest?.status === "matched" ? 201 : 202).send({ matchRequest: latestRequest, job: currentJob });
  });

  app.get("/match-requests/:id", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const matchRequest = await options.store.getMatchRequest(id);
    if (!matchRequest) throw new StoreNotFoundError("匹配请求不存在");
    return { matchRequest };
  });

  app.post("/match-requests/:id/cancel", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    return { matchRequest: await options.store.cancelMatchRequest(id) };
  });

  app.get("/jobs/:id", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const job = await options.store.getJob(id);
    if (!job) throw new StoreNotFoundError("任务不存在");
    return { job };
  });

  app.get("/rooms/:id", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const room = await options.store.getRoom(id);
    if (!room) throw new StoreNotFoundError("房间不存在");
    return { room };
  });

  app.post("/rooms/:id/confirm", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const { userId } = z.object({ userId: uuidSchema }).parse(request.body);
    return { room: await options.store.confirmRoom(id, userId) };
  });

  app.post("/rooms/:id/complete", async (request) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    return { room: await options.store.completeRoom(id) };
  });

  app.post("/rooms/:id/feedback", async (request, reply) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const body = z.object({ userId: uuidSchema }).passthrough().parse(request.body);
    const feedback = postEventFeedbackSchema.parse({ ...body, roomId: id });
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
    if (error instanceof StoreNotFoundError) {
      return reply.code(404).send({ error: "NOT_FOUND", message: error.message, requestId: request.id });
    }
    if (error instanceof StoreConflictError) {
      return reply.code(409).send({ error: "CONFLICT", message: error.message, requestId: request.id });
    }
    request.log.error(error);
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "未知服务错误",
      requestId: request.id
    });
  });

  return app;
}
