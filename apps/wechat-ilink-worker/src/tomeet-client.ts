import { createHash, randomUUID } from "node:crypto";
import {
  agentProductEventSchema,
  agentMessageInputSchema,
  llmJobSchema,
  messageSchema,
  type LlmJob
} from "@tomeet/contracts";

interface TomeetClientOptions {
  baseUrl: string;
  internalApiToken: string;
  pollIntervalMs?: number;
  pollAttempts?: number;
  requestTimeoutMs?: number;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

export interface AgentTurnResult {
  reply: string | null;
  stale: boolean;
}

export class TomeetClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function idempotencyKey(connectionId: string, messageId: string): string {
  return `wechat:${createHash("sha256")
    .update(`${connectionId}:${messageId}`)
    .digest("hex")}`;
}

export class TomeetClient {
  private readonly baseUrl: string;
  private readonly internalApiToken: string;
  private readonly pollIntervalMs: number;
  private readonly pollAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(options: TomeetClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.internalApiToken = options.internalApiToken;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.pollAttempts = options.pollAttempts ?? 180;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  }

  async startOnboarding(input: { userId: string }): Promise<string | null> {
    const response = await this.request<{ message?: unknown | null }>(
      `/internal/users/${input.userId}/adventurex-onboarding/start`,
      {
        method: "POST",
        body: JSON.stringify({ language: "zh" })
      }
    );
    if (response.message == null) return null;
    const message = messageSchema.parse(response.message);
    if (message.role !== "assistant") {
      throw new TomeetClientError(
        502,
        "onboarding_message_invalid",
        "Onboarding endpoint returned a non-assistant message"
      );
    }
    return message.content;
  }

  async markOnboardingWelcomeDelivered(input: { userId: string }): Promise<void> {
    await this.request(
      `/internal/users/${input.userId}/adventurex-onboarding/welcome-delivered`,
      { method: "POST" }
    );
  }

  async sendText(input: {
    connectionId: string;
    messageId: string;
    userId: string;
    content: string;
  }): Promise<string> {
    const payload = agentMessageInputSchema.parse({
      userId: input.userId,
      displayName: "微信用户",
      content: input.content,
      idempotencyKey: idempotencyKey(input.connectionId, input.messageId)
    });
    const response = await this.request<{ job: unknown }>("/internal/agent/messages", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    let job = llmJobSchema.parse(response.job);
    if (job.status !== "completed" && job.status !== "failed") {
      job = await this.waitForJob(job);
    }
    if (job.status === "failed") {
      throw new TomeetClientError(
        502,
        "agent_job_failed",
        job.error || "Agent job failed"
      );
    }
    const directReply = messageSchema.safeParse(job.result?.message);
    if (directReply.success && directReply.data.role === "assistant") {
      return directReply.data.content;
    }
    throw new TomeetClientError(
      502,
      "assistant_reply_missing",
      "WeChat-originated Agent job completed without its assistant message"
    );
  }

  async setResponseGeneration(input: {
    connectionId: string;
    generationToken: string;
  }): Promise<void> {
    await this.request("/internal/agent/response-generations", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async sendTextBatch(input: {
    connectionId: string;
    generationToken: string;
    userId: string;
    turns: Array<{ messageId: string; content: string }>;
  }): Promise<AgentTurnResult> {
    const content = input.turns.length === 1
      ? input.turns[0]!.content
      : input.turns.map((item, index) => `${index + 1}. ${item.content}`).join("\n");
    const payload = agentMessageInputSchema.parse({
      userId: input.userId,
      displayName: "微信用户",
      content,
      idempotencyKey: idempotencyKey(input.connectionId, `generation:${input.generationToken}`)
    });
    const response = await this.request<{ job: unknown }>("/internal/agent/messages", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        connectionId: input.connectionId,
        generationToken: input.generationToken,
        messages: input.turns.map((turn) => ({
          messageId: turn.messageId,
          content: turn.content,
          idempotencyKey: idempotencyKey(input.connectionId, turn.messageId)
        }))
      })
    });
    return this.waitForTurnResult(llmJobSchema.parse(response.job));
  }

  async sendImages(input: {
    connectionId: string;
    generationToken: string;
    userId: string;
    images: Array<{
      messageId: string;
      bytes: Uint8Array;
      mimeType: "image/jpeg" | "image/png" | "image/webp";
    }>;
    turns: Array<{ messageId: string; content?: string; imageCount: number }>;
  }): Promise<AgentTurnResult> {
    const messageKey = idempotencyKey(input.connectionId, `images:${input.generationToken}`);
    const response = await this.request<{ job: unknown }>("/internal/agent/multimodal-inputs", {
      method: "POST",
      body: JSON.stringify({
        userId: input.userId,
        images: input.images.map((image) => ({
          messageId: image.messageId,
          mimeType: image.mimeType,
          dataBase64: Buffer.from(image.bytes).toString("base64")
        })),
        turns: input.turns.map((turn) => ({
          ...turn,
          idempotencyKey: idempotencyKey(input.connectionId, turn.messageId)
        })),
        idempotencyKey: messageKey,
        connectionId: input.connectionId,
        generationToken: input.generationToken
      })
    });
    return this.waitForTurnResult(llmJobSchema.parse(response.job));
  }

  async sendEvent(input: {
    connectionId: string;
    messageId: string;
    userId: string;
    event: unknown;
  }): Promise<string> {
    const event = agentProductEventSchema.parse(input.event);
    const messageKey = idempotencyKey(input.connectionId, `event:${input.messageId}`);
    const response = await this.request<{ job: unknown }>("/internal/agent/events", {
      method: "POST",
      body: JSON.stringify({
        userId: input.userId,
        event,
        idempotencyKey: messageKey
      })
    });
    let job = llmJobSchema.parse(response.job);
    if (job.status !== "completed" && job.status !== "failed") job = await this.waitForJob(job);
    if (job.status === "failed") {
      throw new TomeetClientError(502, "agent_event_job_failed", job.error || "Agent event job failed");
    }
    const directReply = messageSchema.safeParse(job.result?.message);
    if (directReply.success && directReply.data.role === "assistant") return directReply.data.content;
    throw new TomeetClientError(502, "assistant_reply_missing", "Agent event completed without an assistant message");
  }

  private async waitForJob(initial: LlmJob): Promise<LlmJob> {
    let current = initial;
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const response = await this.request<{ job: unknown }>(
        `/internal/jobs/${encodeURIComponent(current.id)}`
      );
      current = llmJobSchema.parse(response.job);
      if (current.status === "completed" || current.status === "failed") return current;
    }
    throw new TomeetClientError(504, "agent_job_timeout", "Agent job timed out");
  }

  private async waitForTurnResult(initial: LlmJob): Promise<AgentTurnResult> {
    const job = initial.status === "completed" || initial.status === "failed"
      ? initial
      : await this.waitForJob(initial);
    if (job.status === "failed") {
      throw new TomeetClientError(502, "agent_job_failed", job.error || "Agent job failed");
    }
    if (job.result?.stale === true) return { reply: null, stale: true };
    const directReply = messageSchema.safeParse(job.result?.message);
    if (directReply.success && directReply.data.role === "assistant") {
      return { reply: directReply.data.content, stale: false };
    }
    throw new TomeetClientError(502, "assistant_reply_missing", "Agent job completed without its assistant message");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-request-id": randomUUID(),
        "x-tomeet-internal-token": this.internalApiToken,
        ...init.headers
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
    if (!response.ok) {
      throw new TomeetClientError(
        response.status,
        body.error ?? "tomeet_api_error",
        body.message ?? `TOMEET API returned ${response.status}`
      );
    }
    return body;
  }
}
