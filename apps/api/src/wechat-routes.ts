import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { StoreConflictError, type WechatConnectionStore } from "@tomeet/data";
import {
  CredentialCipher,
  hashSessionToken,
  sessionTokenMatches,
  type WechatConnectionSession,
  type WechatConnectionSessionStatus,
  type WechatILinkClient,
  type WechatQrStatus
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
  bubbleDelayMs?: number;
}

export interface WechatActivationContext {
  userId: string;
  webRegistrationUrl?: string;
  webRegistrationClaimId?: string;
}

interface ProvisionedWechatWebAccount {
  userId: string;
  accessToken: string;
  refreshToken: string;
  sessionExpiresAt: string;
}

export interface WechatWebRegistrationRuntime {
  registrationUrl: string;
  claimTtlMs?: number;
  accountProvisioner: {
    provision(): Promise<ProvisionedWechatWebAccount>;
    discard(userId: string): Promise<void>;
  };
}

interface WechatActivationCredentials {
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
}

type ScannedSessionHandler = (
  session: WechatConnectionSession,
  credentials?: WechatActivationCredentials
) => void;

interface RegisterWechatRoutesOptions {
  runtime?: WechatApiRuntime;
  internalApiEnabled: boolean;
  internalTokenMatches(candidate: unknown): boolean;
  publicSessionRateLimitMax?: number;
  rapidSessionRateLimitMax?: number;
  rapidQrAccessTokenMatches?(accessToken: string): Promise<boolean>;
  isNewWechatIdentity?(externalUserId: string): Promise<boolean>;
  onActivated?(context: WechatActivationContext): Promise<void>;
  webRegistration?: WechatWebRegistrationRuntime;
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

export function webRegistrationLink(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:"
    && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
  ) {
    throw new Error("微信 Web 注册地址仅允许 HTTPS 或本机 HTTP");
  }
  if (url.username || url.password) throw new Error("微信 Web 注册地址不能包含凭证");
  url.hash = new URLSearchParams({ claim: token }).toString();
  return url.toString();
}

async function createWebRegistrationClaim(
  runtime: WechatApiRuntime,
  account: ProvisionedWechatWebAccount,
  registration: WechatWebRegistrationRuntime
): Promise<{ id: string; url: string }> {
  const sessionExpiresAt = new Date(account.sessionExpiresAt).getTime();
  const expiresAtMs = sessionExpiresAt - 5_000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("Supabase 匿名会话有效期不足，无法创建注册链接");
  }
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await runtime.store.createWechatWebClaim({
    id,
    userId: account.userId,
    tokenHash: hashSessionToken(token),
    tokenCiphertext: runtime.cipher.encrypt(
      token,
      `wechat-web-claim:${id}:token`
    ),
    accessTokenCiphertext: runtime.cipher.encrypt(
      account.accessToken,
      `wechat-web-claim:${id}:access`
    ),
    refreshTokenCiphertext: runtime.cipher.encrypt(
      account.refreshToken,
      `wechat-web-claim:${id}:refresh`
    ),
    expiresAt: new Date(expiresAtMs).toISOString()
  });
  return {
    id,
    url: webRegistrationLink(registration.registrationUrl, token)
  };
}

function activationCredentials(
  result: WechatQrStatus,
  fallbackBaseUrl: string
): WechatActivationCredentials | null {
  if (
    !result.botToken
    || !result.ilinkBotId
    || !result.ilinkUserId
  ) {
    return null;
  }
  return {
    botToken: result.botToken,
    ilinkBotId: result.ilinkBotId,
    ilinkUserId: result.ilinkUserId,
    baseUrl: result.baseUrl ?? fallbackBaseUrl
  };
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

async function activateSession(
  runtime: WechatApiRuntime,
  session: WechatConnectionSession,
  credentials: WechatActivationCredentials,
  onActivated?: (context: WechatActivationContext) => Promise<void>,
  isNewWechatIdentity?: (externalUserId: string) => Promise<boolean>,
  webRegistration?: WechatWebRegistrationRuntime,
  reportWebRegistrationError?: (error: unknown) => void
): Promise<WechatConnectionSession> {
  let baseUrl: string;
  try {
    baseUrl = ensureHttpsBaseUrl(credentials.baseUrl);
  } catch {
    return runtime.store.updateWechatSession(session.id, {
      status: "failed",
      errorCode: "invalid_confirmation_host",
      errorMessage: "微信返回了无效的服务地址，请重新生成二维码"
    }, {
      ifStatusIn: NON_TERMINAL_SESSION_STATUSES
    });
  }
  const isNewIdentity = isNewWechatIdentity
    ? await isNewWechatIdentity(credentials.ilinkUserId)
    : true;
  const shouldQueueOnboardingWelcome = Boolean(
    onActivated && isNewIdentity && !session.requestedUserId
  );
  let provisionedAccount: ProvisionedWechatWebAccount | null = null;
  if (isNewIdentity && !session.requestedUserId && webRegistration) {
    try {
      provisionedAccount = await webRegistration.accountProvisioner.provision();
    } catch (error) {
      reportWebRegistrationError?.(error);
      return runtime.store.updateWechatSession(session.id, {
        status: "failed",
        errorCode: "web_account_provision_failed",
        errorMessage: "暂时无法创建 TOMEET 账号，请重新生成二维码"
      }, {
        ifStatusIn: NON_TERMINAL_SESSION_STATUSES
      });
    }
  }
  let activation: Awaited<ReturnType<WechatConnectionStore["activateWechatSession"]>>;
  try {
    activation = await runtime.store.activateWechatSession({
      sessionId: session.id,
      newUserId: provisionedAccount?.userId ?? randomUUID(),
      ownerIlinkUserId: credentials.ilinkUserId,
      ilinkBotId: credentials.ilinkBotId,
      botTokenCiphertext: runtime.cipher.encrypt(
        credentials.botToken,
        `wechat-connection:${credentials.ilinkUserId}`
      ),
      baseUrl
    });
  } catch (error) {
    if (provisionedAccount && webRegistration) {
      await webRegistration.accountProvisioner.discard(provisionedAccount.userId)
        .catch((discardError: unknown) => reportWebRegistrationError?.(discardError));
    }
    if (error instanceof StoreConflictError) {
      await runtime.store.updateWechatSession(session.id, {
        status: "failed",
        errorCode: "profile_binding_conflict",
        errorMessage: error.message
      }, {
        ifStatusIn: NON_TERMINAL_SESSION_STATUSES
      });
    }
    throw error;
  }
  let registrationUrl: string | undefined;
  let registrationClaimId: string | undefined;
  if (provisionedAccount) {
    if (activation.session.userId === provisionedAccount.userId) {
      try {
        const registration = await createWebRegistrationClaim(
          runtime,
          provisionedAccount,
          webRegistration!
        );
        registrationUrl = registration.url;
        registrationClaimId = registration.id;
      } catch (error) {
        reportWebRegistrationError?.(error);
      }
    } else {
      await webRegistration!.accountProvisioner.discard(provisionedAccount.userId)
        .catch((error: unknown) => reportWebRegistrationError?.(error));
    }
  }
  if (
    activation.session.userId
    && onActivated
    && shouldQueueOnboardingWelcome
    && (!provisionedAccount || activation.session.userId === provisionedAccount.userId)
    && await runtime.store.claimWechatActivationCallback(session.id)
  ) {
    await onActivated({
      userId: activation.session.userId,
      webRegistrationUrl: registrationUrl,
      webRegistrationClaimId: registrationClaimId
    });
  }
  return activation.session;
}

async function pollSession(
  runtime: WechatApiRuntime,
  session: WechatConnectionSession,
  verifyCode?: string,
  signal?: AbortSignal,
  onActivated?: (context: WechatActivationContext) => Promise<void>,
  isNewWechatIdentity?: (externalUserId: string) => Promise<boolean>,
  webRegistration?: WechatWebRegistrationRuntime,
  reportWebRegistrationError?: (error: unknown) => void,
  onScanned?: ScannedSessionHandler
): Promise<WechatConnectionSession> {
  if (isTerminalSession(session)) return session;
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
    case "scaned": {
      const scanned = await runtime.store.updateWechatSession(session.id, {
        status: "scanned",
        errorCode: null,
        errorMessage: null
      }, {
        ifStatusIn: ["pending", "scanned"]
      });
      const credentials = activationCredentials(result, session.pollBaseUrl);
      if (onScanned) {
        onScanned(scanned, credentials ?? undefined);
        return scanned;
      }
      return credentials
        ? activateSession(
            runtime,
            scanned,
            credentials,
            onActivated,
            isNewWechatIdentity,
            webRegistration,
            reportWebRegistrationError
          )
        : scanned;
    }
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
      // iLink returns binded_redirect when the scanned bot matches one of the local tokens
      // submitted with this QR. No new credentials are issued: the existing connection is
      // still valid and must not be replaced or marked as disconnected.
      return runtime.store.updateWechatSession(session.id, {
        status: "active",
        confirmedAt: new Date().toISOString(),
        errorCode: null,
        errorMessage: null
      }, {
        ifStatusIn: NON_TERMINAL_SESSION_STATUSES
      });
    case "scaned_but_redirect": {
      let pollBaseUrl = session.pollBaseUrl;
      if (result.redirectHost) {
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
      }
      const scanned = await runtime.store.updateWechatSession(session.id, {
        status: "scanned",
        pollBaseUrl
      }, {
        ifStatusIn: ["pending", "scanned"]
      });
      const credentials = activationCredentials(result, pollBaseUrl);
      if (onScanned) {
        onScanned(scanned, credentials ?? undefined);
        return scanned;
      }
      return credentials
        ? activateSession(
            runtime,
            scanned,
            credentials,
            onActivated,
            isNewWechatIdentity,
            webRegistration,
            reportWebRegistrationError
          )
        : scanned;
    }
    case "confirmed": {
      const credentials = activationCredentials(result, session.pollBaseUrl);
      if (!credentials) {
        return runtime.store.updateWechatSession(session.id, {
          status: "failed",
          errorCode: "invalid_confirmation",
          errorMessage: "微信确认响应不完整，请重新生成二维码"
        }, {
          ifStatusIn: NON_TERMINAL_SESSION_STATUSES
        });
      }
      return activateSession(
        runtime,
        session,
        credentials,
        onActivated,
        isNewWechatIdentity,
        webRegistration,
        reportWebRegistrationError
      );
    }
  }
}

export function registerWechatRoutes(
  app: FastifyInstance,
  options: RegisterWechatRoutesOptions
): void {
  const claimedSessionMonitors = new Map<string, {
    controller: AbortController;
    task: Promise<void>;
  }>();
  type CreatedSession = NonNullable<Awaited<ReturnType<typeof createSession>>>;
  const rapidQrSlots = new Map<string, {
    current: CreatedSession[];
    inFlight?: Promise<CreatedSession | null>;
  }>();
  const reportWebRegistrationError = (error: unknown) => {
    app.log.error({
      err: error,
      event: "wechat_web_registration_failed"
    });
  };

  const monitorScannedSession: ScannedSessionHandler = (session, credentials) => {
    const runtime = options.runtime;
    if (!runtime || claimedSessionMonitors.has(session.id)) return;
    app.log.info({
      sessionId: session.id,
      hasActivationCredentials: Boolean(credentials),
      event: "wechat_qr_scanned"
    });
    const controller = new AbortController();
    const task = Promise.resolve().then(async () => {
      let current = session;
      if (credentials) {
        current = await activateSession(
          runtime,
          current,
          credentials,
          options.onActivated,
          options.isNewWechatIdentity,
          options.webRegistration,
          reportWebRegistrationError
        );
      }
      while (!controller.signal.aborted && current.status === "scanned") {
        current = await pollSession(
          runtime,
          current,
          undefined,
          controller.signal,
          options.onActivated,
          options.isNewWechatIdentity,
          options.webRegistration,
          reportWebRegistrationError
        );
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        app.log.error({
          err: error,
          sessionId: session.id,
          event: "wechat_claimed_session_monitor_failed"
        });
      }
    }).finally(() => {
      claimedSessionMonitors.delete(session.id);
    });
    claimedSessionMonitors.set(session.id, { controller, task });
  };

  app.addHook("onClose", async () => {
    const monitors = [...claimedSessionMonitors.values()];
    for (const monitor of monitors) monitor.controller.abort();
    await Promise.allSettled(monitors.map((monitor) => monitor.task));
    rapidQrSlots.clear();
  });

  app.post(
    "/auth/wechat/claim",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "10 minutes"
        }
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      const runtime = options.runtime;
      if (!runtime || !options.webRegistration) {
        return reply.code(503).send({
          error: "wechat_web_registration_disabled",
          message: "微信 Web 注册尚未配置"
        });
      }
      const { token } = z.object({
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
      }).parse(request.body ?? {});
      const tokenHash = hashSessionToken(token);
      const pendingClaim = await runtime.store.getWechatWebClaim(tokenHash);
      if (!pendingClaim) {
        return reply.code(401).send({
          error: "wechat_web_claim_invalid",
          message: "注册链接无效、已使用或已过期"
        });
      }
      if (request.authUserId && request.authUserId !== pendingClaim.userId) {
        return reply.code(409).send({
          error: "wechat_web_account_switch_required",
          message: "当前浏览器已登录其他 TOMEET 账号。请先确认退出当前账号，再继续使用微信里的同一个账号；聊天、画像和匹配状态都会保留。"
        });
      }
      const claim = await runtime.store.consumeWechatWebClaim(tokenHash);
      if (!claim) {
        return reply.code(401).send({
          error: "wechat_web_claim_invalid",
          message: "注册链接无效、已使用或已过期"
        });
      }
      return {
        userId: claim.userId,
        session: {
          accessToken: runtime.cipher.decrypt(
            claim.accessTokenCiphertext,
            `wechat-web-claim:${claim.id}:access`
          ),
          refreshToken: runtime.cipher.decrypt(
            claim.refreshTokenCiphertext,
            `wechat-web-claim:${claim.id}:refresh`
          )
        },
        registrationMethods: [
          "email_password",
          "phone_password",
          "google"
        ],
        accountContinuity: {
          mode: "upgrade_existing_wechat_user",
          preserves: ["conversation", "profile", "matching"]
        }
      };
    }
  );

  async function createSession(requestedUserId?: string) {
    const runtime = options.runtime;
    if (!runtime) return null;
    const id = randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    const connections = await runtime.store.listActiveWechatConnectionsForQr(
      10,
      requestedUserId
    );
    const localTokenList: string[] = [];
    for (const connection of connections) {
      try {
        localTokenList.push(
          runtime.cipher.decrypt(
            connection.botTokenCiphertext,
            `wechat-connection:${connection.ownerIlinkUserId}`
          )
        );
      } catch (error) {
        if (requestedUserId && connection.userId === requestedUserId) {
          // Creating a QR without this user's current token could turn a repeat scan into a
          // new login and invalidate the still-working bot. Preserve the existing connection.
          throw error;
        }
        // A damaged credential for another user must not block this QR. It is never logged or
        // included in the request, and the current user's token remains first when available.
      }
    }
    const qr = await runtime.client.createLoginQr({ localTokenList });
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

  async function createOrReuseRapidSession(slotIdentity: string) {
    const runtime = options.runtime;
    if (!runtime) return null;
    const slotKey = createHash("sha256").update(slotIdentity).digest("hex");
    const slot = rapidQrSlots.get(slotKey) ?? { current: [] };
    rapidQrSlots.set(slotKey, slot);
    if (slot.inFlight) return slot.inFlight;

    const task = Promise.resolve().then(async () => {
      const states = await Promise.all(slot.current.map(async (created) => ({
        created,
        session: await runtime.store.getWechatSession(created.session.id)
      })));
      const pending = states
        .filter(({ session }) => (
          session?.status === "pending"
          && new Date(session.expiresAt).getTime() > Date.now()
        ))
        .map(({ created }) => created);
      slot.current = pending;
      if (pending.length >= 2) {
        return pending[pending.length - 1] ?? null;
      }
      const created = await createSession();
      if (created) slot.current.push(created);
      return created;
    }).finally(() => {
      if (slot.inFlight === task) slot.inFlight = undefined;
    });
    slot.inFlight = task;
    return task;
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
    async (request, reply) => {
      const created = await createSession(request.authUserId);
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
    {
      config: {
        rateLimit: {
          max: options.rapidSessionRateLimitMax ?? 120,
          timeWindow: "10 minutes"
        }
      }
    },
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
      // The bearer token identifies the roadshow display, not the visitor. Keep at most the
      // displayed QR plus one standby QR. Concurrent refresh effects are coalesced, and once
      // the displayed code is scanned the standby can be promoted immediately while the
      // claimed session keeps activating in the background.
      const created = await createOrReuseRapidSession(
        request.authUserId ?? accessToken
      );
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
    let current = session;
    if (current.status === "scanned") {
      monitorScannedSession(current);
    } else if (current.status !== "verification_required") {
      current = await pollSession(
        runtime,
        current,
        undefined,
        undefined,
        options.onActivated,
        options.isNewWechatIdentity,
        options.webRegistration,
        reportWebRegistrationError,
        monitorScannedSession
      );
    }
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
        if (current.status === "scanned") {
          monitorScannedSession(current);
          await waitForSignal(250, controller.signal);
          current = (await runtime.store.getWechatSession(current.id)) ?? current;
        } else if (current.status === "verification_required") {
          await waitForSignal(500, controller.signal);
          current = (await runtime.store.getWechatSession(current.id)) ?? current;
        } else {
          current = await pollSession(
            runtime,
            current,
            undefined,
            controller.signal,
            options.onActivated,
            options.isNewWechatIdentity,
            options.webRegistration,
            reportWebRegistrationError,
            monitorScannedSession
          );
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
    const current = await pollSession(
      runtime,
      session,
      code,
      undefined,
      options.onActivated,
      options.isNewWechatIdentity,
      options.webRegistration,
      reportWebRegistrationError,
      monitorScannedSession
    );
    reply.header("Cache-Control", "no-store");
    return publicSession(current);
  });
}
