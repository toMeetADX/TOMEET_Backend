import { createHash, randomUUID } from "node:crypto";
import {
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

    const history = await this.request<{ messages: unknown[] }>(
      `/internal/agent/messages/${encodeURIComponent(input.userId)}`
    );
    for (let index = history.messages.length - 1; index >= 0; index -= 1) {
      const message = messageSchema.safeParse(history.messages[index]);
      if (message.success && message.data.role === "assistant") return message.data.content;
    }
    throw new TomeetClientError(
      502,
      "assistant_reply_missing",
      "Agent completed without an assistant message"
    );
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
