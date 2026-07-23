import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  hashSessionToken,
  sessionTokenMatches,
  type WechatConnectionSession,
  type WechatILinkClient
} from "@tomeet/wechat-ilink";
import { uuidSchema } from "@tomeet/contracts";

const sessionParamsSchema = z.object({ sessionId: uuidSchema });
const verifyCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{4,12}$/)
});

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
  verifyCode?: string
): Promise<WechatConnectionSession> {
  if (session.status === "active" || session.status === "expired" || session.status === "failed") {
    return session;
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    return runtime.store.updateWechatSession(session.id, {
      status: "expired",
      errorCode: "qr_expired",
      errorMessage: "二维码已过期，请重新生成"
    });
  }

  const qrCode = runtime.cipher.decrypt(
    session.qrTokenCiphertext,
    `wechat-session:${session.id}`
  );
  const result = await runtime.client.pollLoginQr({
    qrCode,
    baseUrl: session.pollBaseUrl,
    verifyCode
  });

  switch (result.status) {
    case "wait":
      return session;
    case "scaned":
      return runtime.store.updateWechatSession(session.id, {
        status: "scanned",
        errorCode: null,
        errorMessage: null
      });
    case "need_verifycode":
      return runtime.store.updateWechatSession(session.id, {
        status: "verification_required",
        errorCode: "verification_required",
        errorMessage: "请在当前页面输入微信显示的验证码"
      });
    case "verify_code_blocked":
      return runtime.store.updateWechatSession(session.id, {
        status: "failed",
        errorCode: "verification_blocked",
        errorMessage: "验证码尝试次数过多，请重新生成二维码"
      });
    case "expired":
      return runtime.store.updateWechatSession(session.id, {
        status: "expired",
        errorCode: "qr_expired",
        errorMessage: "二维码已过期，请重新生成"
      });
    case "binded_redirect":
      return runtime.store.updateWechatSession(session.id, {
        status: "failed",
        errorCode: "already_bound_elsewhere",
        errorMessage: "该微信已绑定其他 iLink 客户端，请先解除旧连接后重试"
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
        });
      }
      return runtime.store.updateWechatSession(session.id, {
        status: "scanned",
        pollBaseUrl
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
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
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
