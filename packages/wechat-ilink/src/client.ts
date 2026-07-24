import { randomBytes } from "node:crypto";
import type {
  WechatInboundMessage,
  WechatQrStart,
  WechatQrStatus,
  WechatUpdates
} from "./types.js";

const DEFAULT_QR_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_CHANNEL_VERSION = "2.4.6";

export interface WechatILinkClientOptions {
  fetch?: typeof globalThis.fetch;
  qrBaseUrl?: string;
  appId?: string;
  appClientVersion?: number;
  channelVersion?: string;
  botAgent?: string;
  requestTimeoutMs?: number;
  longPollTimeoutMs?: number;
}

export class WechatILinkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number
  ) {
    super(message);
  }
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error("iLink base URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("iLink base URL must not contain credentials");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function redactIlinkError(value: unknown): string {
  if (value instanceof Error) return value.message.replace(/Bearer\s+\S+/gi, "Bearer ***");
  return String(value);
}

function isAbortLike(error: unknown): error is Error {
  return error instanceof Error
    && (error.name === "AbortError" || error.name === "TimeoutError");
}

export class WechatILinkClient {
  readonly qrBaseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly appId: string;
  private readonly appClientVersion: number;
  private readonly channelVersion: string;
  private readonly botAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly longPollTimeoutMs: number;

  constructor(options: WechatILinkClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.qrBaseUrl = normalizeBaseUrl(options.qrBaseUrl ?? DEFAULT_QR_BASE_URL);
    this.appId = options.appId ?? "bot";
    this.appClientVersion = options.appClientVersion ?? DEFAULT_CLIENT_VERSION;
    this.channelVersion = options.channelVersion ?? DEFAULT_CHANNEL_VERSION;
    this.botAgent = options.botAgent ?? "TOMEET/0.1.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? 35_000;
  }

  async createLoginQr(): Promise<WechatQrStart> {
    const response = await this.request<Record<string, unknown>>(
      this.qrBaseUrl,
      "ilink/bot/get_bot_qrcode?bot_type=3",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ local_token_list: [] })
      },
      this.requestTimeoutMs
    );
    if (typeof response.qrcode !== "string" || typeof response.qrcode_img_content !== "string") {
      throw new WechatILinkError("iLink returned an invalid QR response");
    }
    return {
      qrCode: response.qrcode,
      qrCodeContent: response.qrcode_img_content
    };
  }

  async pollLoginQr(input: {
    qrCode: string;
    baseUrl?: string;
    verifyCode?: string;
    signal?: AbortSignal;
  }): Promise<WechatQrStatus> {
    const query = new URLSearchParams({ qrcode: input.qrCode });
    if (input.verifyCode) query.set("verify_code", input.verifyCode);
    try {
      const response = await this.request<Record<string, unknown>>(
        normalizeBaseUrl(input.baseUrl ?? this.qrBaseUrl),
        `ilink/bot/get_qrcode_status?${query.toString()}`,
        { method: "GET", signal: input.signal },
        this.longPollTimeoutMs
      );
      const status = response.status;
      if (
        status !== "wait"
        && status !== "scaned"
        && status !== "confirmed"
        && status !== "expired"
        && status !== "scaned_but_redirect"
        && status !== "need_verifycode"
        && status !== "verify_code_blocked"
        && status !== "binded_redirect"
      ) {
        throw new WechatILinkError("iLink returned an unknown QR status");
      }
      return {
        status,
        botToken: typeof response.bot_token === "string" ? response.bot_token : undefined,
        ilinkBotId: typeof response.ilink_bot_id === "string" ? response.ilink_bot_id : undefined,
        baseUrl: typeof response.baseurl === "string" ? response.baseurl : undefined,
        ilinkUserId: typeof response.ilink_user_id === "string" ? response.ilink_user_id : undefined,
        redirectHost: typeof response.redirect_host === "string" ? response.redirect_host : undefined
      };
    } catch (error) {
      if (isAbortLike(error)) return { status: "wait" };
      if (
        error instanceof WechatILinkError
        && (
          error.message.startsWith("iLink request failed:")
          || (error.status !== undefined && error.status >= 500)
        )
      ) {
        return { status: "wait" };
      }
      throw error;
    }
  }

  async getUpdates(input: {
    baseUrl: string;
    botToken: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<WechatUpdates> {
    try {
      return await this.request<WechatUpdates>(
        normalizeBaseUrl(input.baseUrl),
        "ilink/bot/getupdates",
        {
          method: "POST",
          headers: this.authHeaders(input.botToken),
          body: JSON.stringify({
            get_updates_buf: input.cursor ?? "",
            base_info: this.baseInfo()
          }),
          signal: input.signal
        },
        this.longPollTimeoutMs
      );
    } catch (error) {
      if (isAbortLike(error)) {
        return { ret: 0, msgs: [], get_updates_buf: input.cursor ?? "" };
      }
      throw error;
    }
  }

  async sendText(input: {
    baseUrl: string;
    botToken: string;
    toUserId: string;
    text: string;
    contextToken?: string;
    runId?: string;
  }): Promise<string> {
    const clientId = `tomeet:${Date.now()}-${randomBytes(4).toString("hex")}`;
    const response = await this.request<{ ret?: number; errmsg?: string }>(
      normalizeBaseUrl(input.baseUrl),
      "ilink/bot/sendmessage",
      {
        method: "POST",
        headers: this.authHeaders(input.botToken),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: input.toUserId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: input.text } }],
            context_token: input.contextToken,
            run_id: input.runId
          },
          base_info: this.baseInfo()
        })
      },
      this.requestTimeoutMs
    );
    if (response.ret && response.ret !== 0) {
      throw new WechatILinkError(
        `iLink send failed: ${response.errmsg ?? "unknown error"}`,
        undefined,
        response.ret
      );
    }
    return clientId;
  }

  static extractText(message: WechatInboundMessage): string | null {
    const text = message.item_list
      ?.map((item) => {
        if (item.type === 1) return item.text_item?.text?.trim() ?? "";
        if (item.type === 3) return item.voice_item?.text?.trim() ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || null;
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return {
      channel_version: this.channelVersion,
      bot_agent: this.botAgent
    };
  }

  private authHeaders(token: string): Record<string, string> {
    const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": uin,
      Authorization: `Bearer ${token}`
    };
  }

  private commonHeaders(): Record<string, string> {
    return {
      "iLink-App-Id": this.appId,
      "iLink-App-ClientVersion": String(this.appClientVersion)
    };
  }

  private async request<T>(
    baseUrl: string,
    endpoint: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${baseUrl.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`,
        {
          ...init,
          headers: { ...this.commonHeaders(), ...init.headers },
          signal
        }
      );
    } catch (error) {
      if (isAbortLike(error)) throw error;
      throw new WechatILinkError(`iLink request failed: ${redactIlinkError(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new WechatILinkError(
        `iLink HTTP ${response.status}`,
        response.status
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WechatILinkError("iLink returned invalid JSON");
    }
  }
}
