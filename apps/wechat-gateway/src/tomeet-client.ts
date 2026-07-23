import { createHash, randomUUID } from "node:crypto";
import {
  agentMessageInputSchema,
  channelIdentitySchema,
  llmJobSchema,
  messageSchema,
  type ChannelIdentity,
  type LlmJob,
  type Message
} from "@tomeet/contracts";

interface TomeetApiClientOptions {
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

export class TomeetApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function messageIdempotencyKey(
  externalUserId: string,
  channelMessageId: string
): string {
  const digest = createHash("sha256")
    .update(`${externalUserId}:${channelMessageId}`)
    .digest("hex");
  return `wechat:${digest}`;
}

export class TomeetApiClient {
  private readonly baseUrl: string;
  private readonly internalApiToken: string;
  private readonly pollIntervalMs: number;
  private readonly pollAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(options: TomeetApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.internalApiToken = options.internalApiToken;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.pollAttempts = options.pollAttempts ?? 90;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  async resolveWeChatIdentity(externalUserId: string): Promise<ChannelIdentity | null> {
    try {
      const body = await this.request<{ identity: unknown }>(
        "/internal/channel-identities/resolve",
        {
          method: "POST",
          headers: { "x-tomeet-internal-token": this.internalApiToken },
          body: JSON.stringify({ provider: "wechat", externalUserId })
        }
      );
      return channelIdentitySchema.parse(body.identity);
    } catch (error) {
      if (
        error instanceof TomeetApiError &&
        error.status === 404 &&
        error.code === "channel_identity_unlinked"
      ) {
        return null;
      }
      throw error;
    }
  }

  async sendText(input: {
    identity: ChannelIdentity;
    displayName: string;
    content: string;
    channelMessageId: string;
  }): Promise<string> {
    const payload = agentMessageInputSchema.parse({
      userId: input.identity.userId,
      displayName: input.displayName,
      content: input.content,
      idempotencyKey: messageIdempotencyKey(
        input.identity.externalUserId,
        input.channelMessageId
      )
    });
    const submitted = await this.request<{ job: unknown }>("/agent/messages", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    let job = llmJobSchema.parse(submitted.job);
    if (job.status !== "completed" && job.status !== "failed") {
      job = await this.waitForJob(job);
    }
    if (job.status === "failed") {
      throw new TomeetApiError(502, "agent_job_failed", job.error || "Agent job failed");
    }

    const history = await this.request<{ messages: unknown[] }>(
      `/agent/messages/${encodeURIComponent(input.identity.userId)}`
    );
    const messages = history.messages.map((message) => messageSchema.parse(message));
    const reply = this.latestAssistantMessage(messages);
    if (!reply) {
      throw new TomeetApiError(
        502,
        "assistant_reply_missing",
        "Agent completed without an assistant message"
      );
    }
    return reply.content;
  }

  private async waitForJob(initial: LlmJob): Promise<LlmJob> {
    let current = initial;
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const response = await this.request<{ job: unknown }>(
        `/jobs/${encodeURIComponent(current.id)}`
      );
      current = llmJobSchema.parse(response.job);
      if (current.status === "completed" || current.status === "failed") {
        return current;
      }
    }
    throw new TomeetApiError(504, "agent_job_timeout", "Agent job timed out");
  }

  private latestAssistantMessage(messages: Message[]): Message | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") return message;
    }
    return null;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-request-id": randomUUID(),
        ...init.headers
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
    if (!response.ok) {
      throw new TomeetApiError(
        response.status,
        body.error ?? "tomeet_api_error",
        body.message ?? `TOMEET API returned ${response.status}`
      );
    }
    return body;
  }
}
