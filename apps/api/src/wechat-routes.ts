import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  hashSessionToken,
  sessionTokenMatches,
  type WechatConnectionSession,
  type WechatConnectionSessionStatus,
  type WechatILinkClient
} from "@tomeet/wechat-ilink";
import { uuidSchema } from "@tomeet/contracts";

const sessionParamsSchema = z.object({ sessionId: uuidSchema });
const verifyCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{4,12}$/)
});
const NON_TERMINAL_SESSION_STATUSES = [
  "pending",
  "scanned",
  "verification_required"
] satisfies WechatConnectionSessionStatus[];
const SSE_HEARTBEAT_MS = 15_000;

export interface WechatApiRuntime {
  store: WechatConnectionStore;
  client: WechatILinkClient;
  cipher: CredentialCipher;
  sessionTtlMs?: number;
}

interface RegisterWechatRoutesOptions {
  runtime?: WechatApiRuntime;
  internalApiEnabled: boolean;
  internalTokenMatches(candidate: unknown): boolean;
  publicSessionRateLimitMax?: number;
  rapidQrAccessTokenMatches?(accessToken: string): Promise<boolean>;
}

function publicSession(session: WechatConnectionSession) {
  return {
    sessionId: session.id,
    status: session.status,
    expiresAt: session.expiresAt,
    confirmedAt: session.confirmedAt,
    errorCode: session.errorCode,
    errorMessage: session.errorMessage
  };
}

function isTerminalSession(session: WechatConnectionSession): boolean {
  return session.status === "active"
    || session.status === "expired"
    || session.status === "failed";
}

function writeSseEvent(
  reply: FastifyReply,
  event: string,
  data: unknown
): void {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function waitForSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function ensureHttpsBaseUrl(value: string): string {
  const withProtocol = value.includes("://") ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "https:") throw new Error("微信 iLink 返回了不安全的服务地址");
  if (parsed.username || parsed.password) {
    throw new Error("微信 iLink 返回的服务地址包含非法凭证");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function requireSession(
  runtime: WechatApiRuntime,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WechatConnectionSession | null> {
  const { sessionId } = sessionParamsSchema.parse(request.params);
  const session = await runtime.store.getWechatSession(sessionId);
  if (!session) {
    reply.code(404).send({ error: "wechat_session_not_found", message: "微信扫码会话不存在" });
    return null;
  }
  const token = request.headers["x-wechat-session-token"];
  if (typeof token !== "string" || !sessionTokenMatches(token, session.sessionTokenHash)) {
    reply.code(401).send({ error: "wechat_session_unauthorized", message: "微信扫码会话凭证无效" });
    return null;
  }
  return session;
}

async function pollSession(
  runtime: WechatApiRuntime,
  session: WechatConnectionSession,
  verifyCode?: string,
  signal?: AbortSignal
): Promise<WechatConnectionSession> {
  if (isTerminalSession(session)) {
    return session;
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    return runtime.store.updateWechatSession(session.id, {
      status: "expired",
      errorCode: "qr_expired",
      errorMessage: "二维码已过期，请重新生成"
    }, {
      ifStatusIn: NON_TERMINAL_SESSION_STATUSES
    });
  }

  const qrCode = runtime.cipher.decrypt(
    session.qrTokenCiphertext,
    `wechat-session:${session.id}`
  );
  const result = await runtime.client.pollLoginQr({
    qrCode,
    baseUrl: session.pollBaseUrl,
    verifyCode,
    signal
  });

  switch (result.status) {
    case "wait":
      return (await runtime.store.getWechatSession(session.id)) ?? session;
    case "scaned":
      return runtime.store.updateWechatSession(session.id, {
        status: "scanned",
        errorCode: null,
        errorMessage: null
      }, {
        ifStatusIn: ["pending", "scanned"]
      });
    case "need_verifycode":
      return runtime.store.updateWechatSession(session.id, {
        status: "verification_required",
        errorCode: "verification_required",
        errorMessage: "请在当前页面输入微信显示的验证码"
      }, {
        ifStatusIn: NON_TERMINAL_SESSION_STATUSES
      });
    case "verify_code_blocked":
      return runtime.store.updateWechatSession(session.id, {
        status: "failed",
        errorCode: "verification_blocked",
        errorMessage: "验证码尝试次数过多，请重新生成二维码"
      }, {
        ifStatusIn: NON_TERMINAL_SESSION_STATUSES
      });
    case "expired":
      return runtime.store.updateWechatSession(session.id, {
        status: "expired",
        errorCode: "qr_expired",
        errorMessage: "二维码已过期，请重新生成"
      }, {
        ifStatusIn: NON_TERMINAL_SESSION_STATUSES
      });
    case "binded_redirect":
      return runtime.store.updateWechatSession(session.id, {
        status: "failed",
        errorCode: "already_bound_elsewhere",
        errorMessage: "该微信已绑定其他 iLink 客户端，请先解除旧连接后重试"
      }, {
        ifStatusIn: NON_TERMINAL_SESSION_STATUSES
      });
    case "scaned_but_redirect": {
      if (!result.redirectHost) return session;
      let pollBaseUrl: string;
      try {
        pollBaseUrl = ensureHttpsBaseUrl(result.redirectHost);
      } catch {
        return runtime.store.updateWechatSession(session.id, {
          status: "failed",
          errorCode: "invalid_redirect_host",
          errorMessage: "微信返回了无效的重定向地址，请重新生成二维码"
        }, {
          ifStatusIn: NON_TERMINAL_SESSION_STATUSES
        });
      }
      return runtime.store.updateWechatSession(session.id, {
        status: "scanned",
        pollBaseUrl
      }, {
        ifStatusIn: ["pending", "scanned"]
      });
    }
    case "confirmed": {
      if (
        !result.botToken
        || !result.ilinkBotId
        || !result.ilinkUserId
        || !result.baseUrl
      ) {
        return runtime.store.updateWechatSession(session.id, {
          status: "failed",
          errorCode: "invalid_confirmation",
          errorMessage: "微信确认响应不完整，请重新生成二维码"
        }, {
          ifStatusIn: NON_TERMINAL_SESSION_STATUSES
        });
      }
      let baseUrl: string;
      try {
        baseUrl = ensureHttpsBaseUrl(result.baseUrl);
      } catch {
        return runtime.store.updateWechatSession(session.id, {
          status: "failed",
          errorCode: "invalid_confirmation_host",
          errorMessage: "微信返回了无效的服务地址，请重新生成二维码"
        }, {
          ifStatusIn: NON_TERMINAL_SESSION_STATUSES
        });
      }
      const activation = await runtime.store.activateWechatSession({
        sessionId: session.id,
        newUserId: randomUUID(),
        ownerIlinkUserId: result.ilinkUserId,
        ilinkBotId: result.ilinkBotId,
        botTokenCiphertext: runtime.cipher.encrypt(
          result.botToken,
          `wechat-connection:${result.ilinkUserId}`
        ),
        baseUrl
      });
      return activation.session;
    }
  }
}

export function registerWechatRoutes(
  app: FastifyInstance,
  options: RegisterWechatRoutesOptions
): void {
  async function createSession(requestedUserId?: string) {
    const runtime = options.runtime;
    if (!runtime) return null;
    const id = randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    const qr = await runtime.client.createLoginQr();
    const expiresAt = new Date(
      Date.now() + (runtime.sessionTtlMs ?? 5 * 60_000)
    ).toISOString();
    const session = await runtime.store.createWechatSession({
      id,
      sessionTokenHash: hashSessionToken(sessionToken),
      qrTokenCiphertext: runtime.cipher.encrypt(
        qr.qrCode,
        `wechat-session:${id}`
      ),
      pollBaseUrl: runtime.client.qrBaseUrl,
      expiresAt,
      requestedUserId
    });
    return {
      session,
      sessionToken,
      qrCodeContent: qr.qrCodeContent
    };
  }

  app.post(
    "/wechat/connect/sessions",
    {
      config: {
        rateLimit: {
          max: options.publicSessionRateLimitMax ?? 30,
          timeWindow: "10 minutes"
        }
      }
    },
    async (_request, reply) => {
      const created = await createSession();
      if (!created) {
        return reply.code(503).send({
          error: "wechat_connect_disabled",
          message: "微信扫码接入尚未配置"
        });
      }
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({
        ...publicSession(created.session),
        sessionToken: created.sessionToken,
        qrCodeContent: created.qrCodeContent
      });
    }
  );

  app.post(
    "/wechat/connect/sessions/demo",
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!options.rapidQrAccessTokenMatches) {
        return reply.code(503).send({
          error: "wechat_rapid_qr_disabled",
          message: "路演二维码模式尚未配置"
        });
      }
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) {
        return reply.code(401).send({
          error: "wechat_rapid_qr_unauthenticated",
          message: "路演二维码模式需要先登录"
        });
      }
      const accessToken = authorization.slice("Bearer ".length).trim();
      if (
        !accessToken
        || !(await options.rapidQrAccessTokenMatches(accessToken))
      ) {
        return reply.code(403).send({
          error: "wechat_rapid_qr_forbidden",
          message: "当前账户不能使用路演二维码模式"
        });
      }
      const created = await createSession();
      if (!created) {
        return reply.code(503).send({
          error: "wechat_connect_disabled",
          message: "微信扫码接入尚未配置"
        });
      }
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({
        ...publicSession(created.session),
        sessionToken: created.sessionToken,
        qrCodeContent: created.qrCodeContent
      });
    }
  );

  app.post(
    "/internal/wechat/connect/sessions",
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (!options.internalApiEnabled) {
        return reply.code(503).send({
          error: "internal_api_disabled",
          message: "内部渠道 API 未配置"
        });
      }
      if (!options.internalTokenMatches(request.headers["x-tomeet-internal-token"])) {
        return reply.code(401).send({ error: "unauthorized", message: "内部服务认证失败" });
      }
      const { userId } = z.object({ userId: uuidSchema }).parse(request.body);
      const created = await createSession(userId);
      if (!created) {
        return reply.code(503).send({
          error: "wechat_connect_disabled",
          message: "微信扫码接入尚未配置"
        });
      }
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({
        ...publicSession(created.session),
        sessionToken: created.sessionToken,
        qrCodeContent: created.qrCodeContent
      });
    }
  );

  app.get("/wechat/connect/sessions/:sessionId", async (request, reply) => {
    const runtime = options.runtime;
    if (!runtime) {
      return reply.code(503).send({
        error: "wechat_connect_disabled",
        message: "微信扫码接入尚未配置"
      });
    }
    const session = await requireSession(runtime, request, reply);
    if (!session) return;
    const current = await pollSession(runtime, session);
    reply.header("Cache-Control", "no-store");
    return publicSession(current);
  });

  app.get("/wechat/connect/sessions/:sessionId/events", async (request, reply) => {
    const runtime = options.runtime;
    if (!runtime) {
      return reply.code(503).send({
        error: "wechat_connect_disabled",
        message: "微信扫码接入尚未配置"
      });
    }
    const session = await requireSession(runtime, request, reply);
    if (!session) return;

    reply
      .header("Content-Type", "text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-store, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no");
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.statusCode = 200;
    reply.raw.flushHeaders();
    reply.raw.write("retry: 1500\n\n");

    const controller = new AbortController();
    let closed = false;
    const close = () => {
      closed = true;
      controller.abort();
    };
    reply.raw.once("close", close);
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, SSE_HEARTBEAT_MS);

    let current = session;
    let lastPayload = "";
    const pushSession = () => {
      const payload = publicSession(current);
      const serialized = JSON.stringify(payload);
      if (serialized === lastPayload) return;
      lastPayload = serialized;
      writeSseEvent(reply, "session", payload);
    };

    try {
      pushSession();
      while (!closed && !isTerminalSession(current)) {
        if (current.status === "verification_required") {
          await waitForSignal(500, controller.signal);
          current = (await runtime.store.getWechatSession(current.id)) ?? current;
        } else {
          current = await pollSession(runtime, current, undefined, controller.signal);
        }
        pushSession();
      }
      if (!closed) {
        writeSseEvent(reply, "done", publicSession(current));
        reply.raw.end();
      }
    } catch {
      if (!closed) {
        writeSseEvent(reply, "error", {
          error: "wechat_session_stream_failed",
          message: "微信状态推送暂时中断"
        });
        reply.raw.end();
      }
    } finally {
      clearInterval(heartbeat);
      reply.raw.off("close", close);
    }
  });

  app.post("/wechat/connect/sessions/:sessionId/verify", async (request, reply) => {
    const runtime = options.runtime;
    if (!runtime) {
      return reply.code(503).send({
        error: "wechat_connect_disabled",
        message: "微信扫码接入尚未配置"
      });
    }
    const session = await requireSession(runtime, request, reply);
    if (!session) return;
    const { code } = verifyCodeSchema.parse(request.body);
    const current = await pollSession(runtime, session, code);
    reply.header("Cache-Control", "no-store");
    return publicSession(current);
  });
}
